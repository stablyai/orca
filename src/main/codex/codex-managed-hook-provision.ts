import { MANAGED_HOOK_TIMEOUT_SECONDS, readHooksJson } from '../agent-hooks/installer-utils'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexConfigTomlPath,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath,
  wrapReadablePosixHookCommand
} from './codex-hook-definition'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookTarget
} from './codex-wsl-hook-install-plan'

/** Enable only Orca's exact managed command at its freshly installed user-scope keys. */
export function enableProvisionedCodexManagedHooks(
  managedHomePath: string,
  target?: CodexWslRuntimeHookTarget
): void {
  const wslPlan = createCodexWslRuntimeHookInstallPlan(managedHomePath, target)
  if (target?.runtime === 'wsl' && !wslPlan) {
    throw new Error('Orca could not resolve the WSL managed Codex hook path')
  }
  const configPath = wslPlan?.configPath ?? getConfigPath(managedHomePath)
  const tomlPath = wslPlan?.tomlPath ?? getCodexConfigTomlPath(managedHomePath)
  const sourcePath = wslPlan?.trustConfigPath ?? getCodexExplicitHomeHookSourcePath(configPath)
  const command = wslPlan
    ? wrapReadablePosixHookCommand(wslPlan.commandScriptPath)
    : getManagedCommand(getManagedScriptPath())
  const hooks = readHooksJson(configPath)?.hooks
  if (!hooks) {
    throw new Error('Orca could not read the managed Codex hooks after installation')
  }
  const states = readHookTrustEntries(tomlPath)
  const entries: CodexTrustEntry[] = []
  for (const event of CODEX_EVENTS) {
    if (hooks[event]?.[0]?.hooks?.[0]?.command !== command) {
      throw new Error(`Orca managed Codex hook missing for ${event}`)
    }
    const entry: CodexTrustEntry = {
      sourcePath,
      eventLabel: CODEX_EVENT_LABEL[event],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    }
    const trustedHash = states.get(computeTrustKey(entry))?.trustedHash
    if (!trustedHash) {
      throw new Error(`Orca managed Codex hook lacks trust for ${event}`)
    }
    entries.push({ ...entry, trustedHash, enabled: true })
  }
  upsertHookTrustEntries(tomlPath, entries)
  const verified = readHookTrustEntries(tomlPath)
  if (
    entries.some((entry) => {
      const state = verified.get(computeTrustKey(entry))
      return state?.trustedHash !== entry.trustedHash || state.enabled !== true
    })
  ) {
    throw new Error('Orca managed Codex hook trust did not remain enabled')
  }
}
