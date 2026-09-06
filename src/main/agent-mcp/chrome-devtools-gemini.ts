import { isAbsolute, join } from 'node:path'
import {
  CHROME_DEVTOOLS_NAME,
  isRecord,
  readConfig,
  type ConfigPlan
} from './chrome-devtools-config'
import { parseJsoncConfig } from './chrome-devtools-jsonc'
import { planStdioJsonConfig } from './chrome-devtools-stdio-json'

export function planGeminiConfig(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ConfigPlan {
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) {
    throw new Error(
      'Gemini system config overrides are active; review them before configuring the user file.'
    )
  }
  const root = env.GEMINI_CLI_HOME || home
  if (!isAbsolute(root)) {
    throw new Error('GEMINI_CLI_HOME must be an absolute parent directory of .gemini.')
  }
  const configPath = join(root, '.gemini', 'settings.json')
  const before = readConfig(configPath)
  const parsed = parseJsoncConfig(before ?? '{}', configPath, 'Gemini')
  const admin = isRecord(parsed.admin) ? parsed.admin : {}
  if (
    (isRecord(admin.mcp) && admin.mcp.enabled === false) ||
    (isRecord(parsed.mcp) &&
      ((Array.isArray(parsed.mcp.allowed) && !parsed.mcp.allowed.includes(CHROME_DEVTOOLS_NAME)) ||
        (Array.isArray(parsed.mcp.excluded) && parsed.mcp.excluded.includes(CHROME_DEVTOOLS_NAME))))
  ) {
    throw new Error(
      `Gemini MCP policy blocks chrome-devtools in ${configPath}; review it manually.`
    )
  }
  return planStdioJsonConfig('gemini', configPath, before, platform)
}
