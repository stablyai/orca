import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { resolveOpenCodeConfigDirectory } from '../../../shared/agent-launch/plugins/opencode/opencode-config-directory'
import { openCodeTuiPluginDirName } from '../../../shared/agent-launch/plugins/opencode/opencode-tui-plugin-install'
import { ORCA_OPENCODE_PLUGIN_FILE } from '../../opencode/status-hooks/overlay-dir-names'
import { ORCA_PI_AGENT_STATUS_EXTENSION_FILE } from '../../pi/managed-extensions/agent-status/agent-status-extension-source'
import { ORCA_PI_PREFILL_EXTENSION_FILE } from '../../pi/managed-extensions/prefill-extension-source'
import { ORCA_PI_EXTENSION_FILE } from '../../pi/managed-extensions/titlebar-extension-source'

/** OpenCode and Pi load Orca's status code as plugin files, outside the hook registry. */
export type PluginHookAgent = 'opencode' | 'pi' | 'omp' | 'prime-agent'

export type PluginHookFiles = { agent: PluginHookAgent; paths: string[] }

export type PluginHookRemoval = PluginHookFiles & { error: string | null }

type Locations = { homeDir?: string; openCodeConfigDir?: string }

// Every generated OpenCode plugin reads Orca's hook endpoint variables.
const OPENCODE_MARKER = 'ORCA_AGENT_HOOK_'
const PI_MARKER = '@orca-managed-pi-extension'
const OPENCODE_PLUGIN_FILES = [ORCA_OPENCODE_PLUGIN_FILE, 'orca-opencode2-status.js']
const PI_EXTENSION_FILES = [
  ORCA_PI_EXTENSION_FILE,
  ORCA_PI_PREFILL_EXTENSION_FILE,
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE
]
const PI_HOME_DIRS: Record<Exclude<PluginHookAgent, 'opencode'>, string> = {
  pi: '.pi',
  omp: '.omp',
  'prime-agent': '.prime'
}

function hasMarker(path: string, marker: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(marker)
  } catch {
    return false
  }
}

function openCodeFiles(configDir: string): string[] {
  const pluginsDir = join(configDir, 'plugins')
  return OPENCODE_PLUGIN_FILES.flatMap((file) => [
    join(pluginsDir, file),
    join(pluginsDir, openCodeTuiPluginDirName(file), 'tui.js')
  ]).filter((path) => hasMarker(path, OPENCODE_MARKER))
}

/** Only files carrying Orca's marker; a user's file with the same name is never listed. */
export function findPluginHookFiles(locations: Locations = {}): PluginHookFiles[] {
  const home = locations.homeDir ?? homedir()
  const openCode = openCodeFiles(locations.openCodeConfigDir ?? resolveOpenCodeConfigDirectory())
  const pi = (Object.keys(PI_HOME_DIRS) as (keyof typeof PI_HOME_DIRS)[]).map((agent) => ({
    agent,
    paths: PI_EXTENSION_FILES.map((file) =>
      join(home, PI_HOME_DIRS[agent], 'agent', 'extensions', file)
    ).filter((path) => hasMarker(path, PI_MARKER))
  }))
  return [{ agent: 'opencode' as const, paths: openCode }, ...pi].filter(
    (entry) => entry.paths.length > 0
  )
}

// OpenCode 1.x lists the TUI copy in tui.json; a dangling entry would fail its plugin load.
function unregisterOpenCodeTuiEntry(tuiEntry: string): void {
  const configDir = dirname(dirname(dirname(tuiEntry)))
  const href = pathToFileURL(tuiEntry).href
  for (const name of ['tui.jsonc', 'tui.json']) {
    const configPath = join(configDir, name)
    if (!existsSync(configPath)) {
      continue
    }
    const text = readFileSync(configPath, 'utf8')
    const errors: ParseError[] = []
    const config: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length || typeof config !== 'object' || !config || !('plugin' in config)) {
      continue
    }
    const plugins = config.plugin
    if (!Array.isArray(plugins) || !plugins.includes(href)) {
      continue
    }
    const next = plugins.filter((item) => item !== href)
    writeFileSync(
      configPath,
      applyEdits(
        text,
        modify(text, ['plugin'], next, { formattingOptions: { tabSize: 2, insertSpaces: true } })
      )
    )
  }
}

function removeFile(path: string): void {
  unlinkSync(path)
  if (path.endsWith(`${join('-tui', 'tui.js')}`)) {
    unregisterOpenCodeTuiEntry(path)
    const dir = dirname(path)
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir)
    }
  }
}

export function removePluginHookFiles(
  options: Locations & { agents?: readonly string[] } = {}
): PluginHookRemoval[] {
  const allowed = options.agents ? new Set(options.agents) : null
  return findPluginHookFiles(options)
    .filter((entry) => allowed === null || allowed.has(entry.agent))
    .map((entry) => {
      try {
        entry.paths.forEach(removeFile)
        return { ...entry, error: null }
      } catch (error) {
        return { ...entry, error: error instanceof Error ? error.message : String(error) }
      }
    })
}
