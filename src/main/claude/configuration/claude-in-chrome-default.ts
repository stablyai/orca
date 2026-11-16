import { readClaudeGlobalConfig } from './claude-global-config'

const CLAUDE_IN_CHROME_ENV = 'CLAUDE_CODE_ENABLE_CFC'

/** SDK sessions ignore Claude in Chrome's "Enabled by default" setting, so pass --chrome as the
 *  terminal would apply it; a launch that already chooses by flag or env keeps its choice. */
export async function claudeInChromeDefaultArgs(
  env: Record<string, string>,
  /** The command's prefix and the configured arguments, as typed. */
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, null>> {
  const chosen =
    args.some((arg) => arg === '--chrome' || arg === '--no-chrome') ||
    Object.keys(env).some(
      (key) => (platform === 'win32' ? key.toUpperCase() : key) === CLAUDE_IN_CHROME_ENV
    )
  if (chosen) {
    return {}
  }
  const config = await readClaudeGlobalConfig(env, platform)
  return config?.claudeInChromeDefaultEnabled === true ? { chrome: null } : {}
}
