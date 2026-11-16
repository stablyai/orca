import { readClaudeGlobalConfig } from './claude-global-config'

const CLAUDE_IN_CHROME_ENV = 'CLAUDE_CODE_ENABLE_CFC'

/** SDK sessions ignore Claude in Chrome's "Enabled by default" setting, so pass --chrome as the
 *  terminal would apply it; a launch that already chooses by flag or env keeps its choice. */
export async function claudeInChromeDefaultArgs(
  env: Record<string, string>,
  configuredArgs: Readonly<Record<string, string | null>>,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, null>> {
  const chosen =
    Object.hasOwn(configuredArgs, 'chrome') ||
    Object.hasOwn(configuredArgs, 'no-chrome') ||
    Object.keys(env).some(
      (key) => (platform === 'win32' ? key.toUpperCase() : key) === CLAUDE_IN_CHROME_ENV
    )
  if (chosen) {
    return {}
  }
  const config = await readClaudeGlobalConfig(env, platform)
  return config?.claudeInChromeDefaultEnabled === true ? { chrome: null } : {}
}
