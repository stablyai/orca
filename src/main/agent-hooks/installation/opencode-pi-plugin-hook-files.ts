import { readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
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
const PI_HOMES: readonly { agent: PluginHookAgent; dir: string }[] = [
  { agent: 'pi', dir: '.pi' },
  { agent: 'omp', dir: '.omp' },
  { agent: 'prime-agent', dir: '.prime' }
]

async function hasMarker(path: string, marker: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(marker)
  } catch {
    return false
  }
}

async function withMarker(paths: string[], marker: string): Promise<string[]> {
  const marked = await Promise.all(paths.map((path) => hasMarker(path, marker)))
  return paths.filter((_, index) => marked[index])
}

function openCodeCandidates(configDir: string): string[] {
  const pluginsDir = join(configDir, 'plugins')
  return OPENCODE_PLUGIN_FILES.flatMap((file) => [
    join(pluginsDir, file),
    join(pluginsDir, openCodeTuiPluginDirName(file), 'tui.js')
  ])
}

/** Only files carrying Orca's marker; a user's file with the same name is never listed. */
export async function findPluginHookFiles(locations: Locations = {}): Promise<PluginHookFiles[]> {
  const home = locations.homeDir ?? homedir()
  const configDir = locations.openCodeConfigDir ?? resolveOpenCodeConfigDirectory()
  const entries = await Promise.all([
    withMarker(openCodeCandidates(configDir), OPENCODE_MARKER).then((paths): PluginHookFiles => ({
      agent: 'opencode',
      paths
    })),
    ...PI_HOMES.map(async ({ agent, dir }): Promise<PluginHookFiles> => ({
      agent,
      paths: await withMarker(
        PI_EXTENSION_FILES.map((file) => join(home, dir, 'agent', 'extensions', file)),
        PI_MARKER
      )
    }))
  ])
  return entries.filter((entry) => entry.paths.length > 0)
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// OpenCode 1.x lists the TUI copy in tui.json; a dangling entry would fail its plugin load.
async function unregisterOpenCodeTuiEntry(tuiEntry: string): Promise<void> {
  const configDir = dirname(dirname(dirname(tuiEntry)))
  const href = pathToFileURL(tuiEntry).href
  for (const name of ['tui.jsonc', 'tui.json']) {
    const configPath = join(configDir, name)
    const text = await readTextOrNull(configPath)
    if (text === null) {
      continue
    }
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
    await writeFile(
      configPath,
      applyEdits(
        text,
        modify(text, ['plugin'], next, { formattingOptions: { tabSize: 2, insertSpaces: true } })
      )
    )
  }
}

async function removeFile(path: string): Promise<void> {
  await unlink(path)
  if (path.endsWith(`${join('-tui', 'tui.js')}`)) {
    await unregisterOpenCodeTuiEntry(path)
    const dir = dirname(path)
    if ((await readdir(dir)).length === 0) {
      await rmdir(dir)
    }
  }
}

export async function removePluginHookFiles(
  options: Locations & { agents?: readonly string[] } = {}
): Promise<PluginHookRemoval[]> {
  const allowed = options.agents ? new Set(options.agents) : null
  const found = (await findPluginHookFiles(options)).filter(
    (entry) => allowed === null || allowed.has(entry.agent)
  )
  return Promise.all(
    found.map(async (entry) => {
      try {
        for (const path of entry.paths) {
          await removeFile(path)
        }
        return { ...entry, error: null }
      } catch (error) {
        return { ...entry, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}
