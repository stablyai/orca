import { OpenCodeHookService } from './hook-service'
import { OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY } from '../../shared/opencode-startup-prompt-install'
import { join } from 'node:path'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'
import { isOverlayOpenCodePluginCurrent } from '../../shared/opencode-installed-plugin'
import { getOpenCodeStartupPromptSource } from './opencode-startup-prompt-source'
import {
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV
} from '../../shared/opencode-startup-prompt'

export function createOpenCodeStartupPromptInstaller(source: () => string): OpenCodeHookService {
  return new OpenCodeHookService({
    pluginFileName: `${OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY}.js`,
    legacyHooksDir: 'opencode-startup-prompt-hooks',
    overlayDir: 'opencode-startup-prompt-overlays',
    pluginSource: source,
    tuiOnlyDirectory: OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY
  })
}

const installer = createOpenCodeStartupPromptInstaller(getOpenCodeStartupPromptSource)

export function installOpenCodeStartupPromptForLaunch(
  env: Record<string, string>,
  restoreAfterShellStartup = true,
  sourceEnvironment: NodeJS.ProcessEnv = { ...process.env, ...env }
): boolean {
  const nonce = env[OPENCODE_STARTUP_PROMPT_NONCE_ENV]
  if (!nonce || env.ORCA_OPENCODE_PLUGIN_API !== 'v2') {
    return false
  }
  const source =
    env.OPENCODE_CONFIG_DIR ||
    sourceEnvironment.OPENCODE_CONFIG_DIR ||
    resolveOpenCodeConfigDirectory(sourceEnvironment)
  const overlay = installer.buildPtyEnv(nonce, source).OPENCODE_CONFIG_DIR
  if (
    !overlay ||
    !isOverlayOpenCodePluginCurrent(
      join(overlay, 'plugins', OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY, 'tui.js'),
      getOpenCodeStartupPromptSource()
    )
  ) {
    for (const key of [
      OPENCODE_STARTUP_PROMPT_NONCE_ENV,
      OPENCODE_STARTUP_PROMPT_SHA256_ENV,
      OPENCODE_STARTUP_PROMPT_BODY_ENV,
      OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV
    ]) {
      delete env[key]
    }
    return false
  }
  env.OPENCODE_CONFIG_DIR = overlay
  if (restoreAfterShellStartup) {
    env.ORCA_OPENCODE_CONFIG_DIR = overlay
  }
  return true
}

export function ensureOpenCodeStartupPromptForLaunch(env: Record<string, string>): void {
  if (env[OPENCODE_STARTUP_PROMPT_NONCE_ENV] && !installOpenCodeStartupPromptForLaunch(env)) {
    throw new Error('Cannot prepare OpenCode startup prompt; launch was canceled.')
  }
}
