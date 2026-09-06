import {
  CHROME_DEVTOOLS_NAME,
  chromeDevtoolsCommand,
  configConflict,
  isRecord,
  matchesCommand,
  type ConfigPlan
} from './chrome-devtools-config'
import { editJsoncConfig, parseJsoncConfig } from './chrome-devtools-jsonc'

export function planStdioJsonConfig(
  agent: 'gemini' | 'pi',
  configPath: string,
  before: string | null,
  platform: NodeJS.Platform
): ConfigPlan {
  const source = before ?? '{}\n'
  const parsed = parseJsoncConfig(source, configPath)
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw configConflict(configPath)
  }
  const existing = isRecord(parsed.mcpServers) ? parsed.mcpServers[CHROME_DEVTOOLS_NAME] : undefined
  const command = chromeDevtoolsCommand(platform)
  const timeoutKey = agent === 'pi' ? 'requestTimeoutMs' : 'timeout'
  if (existing !== undefined) {
    if (
      !isRecord(existing) ||
      existing.command !== command[0] ||
      !matchesCommand(existing.args, command.slice(1)) ||
      (existing[timeoutKey] !== undefined &&
        (typeof existing[timeoutKey] !== 'number' ||
          !Number.isFinite(existing[timeoutKey]) ||
          existing[timeoutKey] <= 0)) ||
      Object.keys(existing).some((key) => !['command', 'args', timeoutKey].includes(key))
    ) {
      throw configConflict(configPath)
    }
    return { agent, configPath, before, after: source }
  }
  const after = editJsoncConfig(source, ['mcpServers', CHROME_DEVTOOLS_NAME], {
    command: command[0],
    args: command.slice(1),
    [timeoutKey]: 60000
  })
  return { agent, configPath, before, after }
}
