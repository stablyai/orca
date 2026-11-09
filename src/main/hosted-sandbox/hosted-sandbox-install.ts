// Wires Orca Cloud into the desktop when this build has a control plane configured (off by default).
import { app, BrowserWindow } from 'electron'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'
import { getHostedSandboxConfig } from './hosted-sandbox-config'
import {
  ORCA_CLOUD_RECIPE,
  createHostedSandboxRecipeDriver,
  registerHostedSandboxRecipe
} from './hosted-sandbox-recipe'
import { createHostedSessionRegistry, type HostedSessionRegistry } from './hosted-session-registry'
import { setHostedSessionSync } from './hosted-session-sync'

let installed: { registry: HostedSessionRegistry } | null = null

export function installHostedSandbox(): void {
  if (installed) {
    return
  }
  const userDataPath = app.getPath('userData')
  const config = getHostedSandboxConfig(userDataPath, process.env, app.isPackaged)
  if (!config) {
    return
  }
  const base = createHostedSandboxRecipeDriver(config)
  // Dev rehearsals shorten idle sleep; packaged builds always use the provider's default.
  const idleOverride = app.isPackaged
    ? Number.NaN
    : Number(process.env.ORCA_CLOUD_SANDBOX_IDLE_STOP_MS)
  const driver = Number.isFinite(idleOverride)
    ? { ...base, capabilities: { ...base.capabilities, idleStopMs: idleOverride } }
    : base
  const registry = createHostedSessionRegistry({
    userDataPath,
    driver,
    windows: () => BrowserWindow.getAllWindows()
  })
  // Records land after the step answers and wakes can come from any path, so reconcile on a slow beat too.
  let beat: ReturnType<typeof setTimeout> | null = null
  const schedule = (ms: number): void => {
    beat = setTimeout(() => {
      void registry.sync().finally(() => schedule(30_000))
    }, ms)
    beat.unref?.()
  }
  registerHostedSandboxRecipe(driver, {
    onReady: () => setTimeout(() => void registry.sync(), 3_000).unref?.(),
    onStopped: (environmentId) => registry.stopEnvironment(environmentId)
  })
  installed = { registry }
  setHostedSessionSync(() => void registry.sync())
  schedule(0)
  app.once('will-quit', () => {
    if (beat) {
      clearTimeout(beat)
    }
    registry.dispose()
  })
}

/** Built-in providers (Orca Cloud) ride along with approved plugin recipes and lead every list. */
export async function withProviderRecipes(pluginService?: PluginService): Promise<OrcaVmRecipe[]> {
  return [
    ...(installed ? [ORCA_CLOUD_RECIPE] : []),
    ...(await getApprovedPluginVmRecipes(pluginService))
  ]
}
