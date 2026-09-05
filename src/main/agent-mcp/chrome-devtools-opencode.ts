import { applyEdits, modify, parse, visit, type ParseError } from 'jsonc-parser'
import { join, isAbsolute } from 'node:path'
import {
  CHROME_DEVTOOLS_NAME,
  chromeDevtoolsCommand,
  configConflict,
  isRecord,
  matchesCommand,
  readConfig,
  type ConfigPlan
} from './chrome-devtools-config'

function parseConfig(contents: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true })
  const keys: Set<string>[] = []
  let duplicate = false
  visit(contents, {
    onObjectBegin: () => {
      keys.push(new Set())
    },
    onObjectProperty: (key) => {
      const current = keys.at(-1)
      if (!current) {
        return
      }
      if (current.has(key)) {
        duplicate = true
      }
      current.add(key)
    },
    onObjectEnd: () => {
      keys.pop()
    }
  })
  if (errors.length || duplicate || !isRecord(parsed)) {
    throw new Error(`Invalid or ambiguous OpenCode JSON/JSONC config: ${path}`)
  }
  if (parsed.$schema !== undefined && parsed.$schema !== 'https://opencode.ai/config.json') {
    throw new Error(`Unsupported OpenCode schema in ${path}; this command supports OpenCode v1.`)
  }
  if (parsed.version !== undefined || parsed.mcpServers !== undefined) {
    throw new Error(`Unsupported OpenCode config layout in ${path}; expected v1 mcp entries.`)
  }
  return parsed
}

export function planOpenCodeConfig(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ConfigPlan {
  if (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT) {
    throw new Error(
      'OPENCODE_CONFIG/OPENCODE_CONFIG_CONTENT overrides are active; unset them before configuring the global file.'
    )
  }
  const configRoot = env.XDG_CONFIG_HOME || join(home, '.config')
  if (!isAbsolute(configRoot)) {
    throw new Error('XDG_CONFIG_HOME must be an absolute path.')
  }
  const base = join(configRoot, 'opencode')
  const jsonPath = join(base, 'opencode.json')
  const jsoncPath = join(base, 'opencode.jsonc')
  const json = readConfig(jsonPath)
  const jsonc = readConfig(jsoncPath)
  if (json !== null && jsonc !== null) {
    throw new Error(`Both ${jsonPath} and ${jsoncPath} exist; resolve this ambiguity first.`)
  }
  const configPath = jsonc !== null ? jsoncPath : jsonPath
  const before = jsonc ?? json
  const source = before ?? '{}\n'
  const parsed = parseConfig(source, configPath)
  if (parsed.mcp !== undefined && !isRecord(parsed.mcp)) {
    throw configConflict(configPath)
  }
  const mcp = isRecord(parsed.mcp) ? parsed.mcp : {}
  if (isRecord(mcp.servers) && mcp.servers.type !== 'local' && mcp.servers.type !== 'remote') {
    throw new Error(`Unsupported OpenCode v2 mcp.servers layout in ${configPath}.`)
  }
  const existing = mcp[CHROME_DEVTOOLS_NAME]
  const command = chromeDevtoolsCommand(platform)
  if (existing !== undefined) {
    if (
      !isRecord(existing) ||
      existing.type !== 'local' ||
      (existing.enabled !== undefined && existing.enabled !== true) ||
      (existing.timeout !== undefined &&
        (typeof existing.timeout !== 'number' ||
          !Number.isFinite(existing.timeout) ||
          existing.timeout <= 0)) ||
      !matchesCommand(existing.command, command) ||
      Object.keys(existing).some((key) => !['type', 'enabled', 'command', 'timeout'].includes(key))
    ) {
      throw configConflict(configPath)
    }
    return { agent: 'opencode', configPath, before, after: source }
  }
  const after = applyEdits(
    source,
    modify(
      source,
      ['mcp', CHROME_DEVTOOLS_NAME],
      {
        type: 'local',
        command,
        enabled: true,
        timeout: 60000
      },
      {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: source.includes('\r\n') ? '\r\n' : '\n'
        }
      }
    )
  )
  parseConfig(after, configPath)
  return { agent: 'opencode', configPath, before, after }
}
