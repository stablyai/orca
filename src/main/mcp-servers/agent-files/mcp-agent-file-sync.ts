// Grok's, Cursor's and Droid's terminal CLIs read MCP servers only from their own file, so once the
// user allows it per agent, Orca keeps one `orca mcp connect` entry per server there (on for that
// agent), and takes them back out when the server goes, is turned off for the agent, or the consent
// is withdrawn. Entries another Orca or the user owns are never touched. With the switch off, nothing
// is written; entries left from before answer as servers with no tools.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'
import { MCP_FILE_AGENTS, type McpFileAgent } from '../../../shared/mcp-servers/mcp-servers'
import { prependOrcaCliDirToChildPath } from '../../cli/launchers/orca-cli-child-path'
import {
  readAgentConfigText,
  writeAgentConfigIfUnchanged
} from '../agent-configs/agent-config-file-write'
import {
  agentMcpConfigLocations,
  type AgentMcpConfigContext
} from '../agent-configs/agent-mcp-config-locations'
import { readMcpHostList } from '../mcp-host-list'
import { mcpHostListFolder } from '../mcp-host-list-folder'
import { onMcpHostListChanged } from '../mcp-host-list-changes'
import { isMcpServersFeatureEnabled } from '../mcp-servers-feature'
import {
  mcpAgentFileEntry,
  mcpAgentFileEntryName,
  mcpAgentFileMarkers,
  mcpHostServerNameOfEntry,
  type McpAgentFileEntry
} from './mcp-agent-file-entry'
import { McpAgentFileLedger } from './mcp-agent-file-ledger'
import {
  hasMcpServersTable,
  isEmptyMcpAgentFile,
  mcpAgentFileServerNames,
  mcpAgentFileValue,
  otherOrcasServerNames,
  withOrcaEntries,
  withoutOrcaEntries,
  type McpAgentFileEdit
} from './mcp-agent-file-text'

/** A file that changes under every attempt is left for the next change to sync. */
const ATTEMPTS = 3

export type McpAgentFileSyncDeps = {
  /** The host list's folder. */
  folder: string
  userDataPath: string
  /** This app's CLI; null when it can't be found, so no entry can be written. */
  launcher: string | null
  context: AgentMcpConfigContext
  ledger: McpAgentFileLedger
  log: (message: string) => void
}

export async function syncMcpAgentFiles(deps: McpAgentFileSyncDeps): Promise<void> {
  if (!isMcpServersFeatureEnabled()) {
    return
  }
  const { servers, agentFiles } = await readMcpHostList(deps.folder)
  for (const agent of MCP_FILE_AGENTS) {
    if (agentFiles[agent] && deps.launcher === null) {
      deps.log(`[mcp-servers] Orca's CLI wasn't found, so ${agent}'s MCP file is left as it is`)
      continue
    }
    const launcher = deps.launcher
    const wanted = new Map<string, McpAgentFileEntry>(
      agentFiles[agent] && launcher !== null
        ? servers
            .filter((server) => !server.agentsOff.includes(agent))
            .map((server) => [
              mcpAgentFileEntryName(server.name, deps.userDataPath),
              mcpAgentFileEntry(
                { userDataPath: deps.userDataPath, launcher },
                server.id,
                agent,
                deps.context.platform
              )
            ])
        : []
    )
    try {
      await syncAgentFile(agent, wanted, deps)
    } catch (error) {
      deps.log(`[mcp-servers] couldn't update ${agent}'s MCP file: ${String(error)}`)
    }
  }
}

async function syncAgentFile(
  agent: McpFileAgent,
  wanted: ReadonlyMap<string, McpAgentFileEntry>,
  deps: McpAgentFileSyncDeps
): Promise<void> {
  const [location] = await agentMcpConfigLocations(agent, deps.context)
  if (!location) {
    return
  }
  const edit: McpAgentFileEdit = {
    agent,
    format: location.format,
    markers: mcpAgentFileMarkers(deps.userDataPath)
  }
  // A file Orca wrote where GROK_HOME (or the others) used to point loses its entries too.
  const retired = Object.entries((await deps.ledger.read()).files)
    .filter(([path, record]) => record.agent === agent && path !== location.path)
    .map(([path]) => path)
  for (const path of retired) {
    await syncFile(path, edit, new Map(), deps)
  }
  await syncFile(location.path, edit, wanted, deps)
}

async function syncFile(
  path: string,
  edit: McpAgentFileEdit,
  wanted: ReadonlyMap<string, McpAgentFileEntry>,
  deps: McpAgentFileSyncDeps
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (await syncFileOnce(path, edit, wanted, deps)) {
      return
    }
  }
  deps.log(`[mcp-servers] ${path} kept changing; it syncs again on the next change`)
}

/** False when the file changed while it was being written, so the caller reads it again. */
async function syncFileOnce(
  path: string,
  edit: McpAgentFileEdit,
  wanted: ReadonlyMap<string, McpAgentFileEntry>,
  deps: McpAgentFileSyncDeps
): Promise<boolean> {
  const record = (await deps.ledger.read()).files[path] ?? null
  // Without a record a JSON entry can't be told from the user's; a TOML block's markers still can.
  const nothingToDo = !record && wanted.size === 0
  if (nothingToDo && edit.format === 'json') {
    return true
  }
  const current = await readAgentConfigText(path)
  if (nothingToDo && !current?.includes(edit.markers.startMarker)) {
    return true
  }
  if (current !== null && mcpAgentFileServerNames(edit, current) === null) {
    deps.log(`[mcp-servers] ${path} doesn't parse, so Orca leaves it as it is`)
    return true
  }
  const recognized = new Map(
    [...wanted].map(([name, entry]) => [name, mcpAgentFileValue(edit.agent, entry)] as const)
  )
  // Untouched since Orca's last write, the file goes back to exactly what it was; edited since,
  // only Orca's own entries come out and the user's edits stay.
  const before =
    record && current === record.written
      ? record.before
      : current === null
        ? null
        : withoutOrcaEntries(
            edit,
            current,
            record?.entries ?? {},
            recognized,
            record?.addedTable ?? false
          )
  const created = current === null || (record?.created ?? false)
  const taken = before === null ? new Set<string>() : mcpAgentFileServerNames(edit, before)
  // A name the user (or another Orca) already uses stays theirs, and so does a server name the user
  // keeps in the agent itself: that server runs from there, not twice. Another Orca's bridge entry
  // under the bare name (an older build) doesn't count as the user's; a copy of this Orca's own entry
  // the user renamed does.
  const orcaNames =
    before === null ? new Set<string>() : otherOrcasServerNames(edit, before, deps.userDataPath)
  const adding = new Map(
    [...wanted].filter(([name, entry]) => {
      const serverName = mcpHostServerNameOfEntry(name, entry.env, deps.userDataPath) ?? name
      return !taken?.has(name) && !(taken?.has(serverName) && !orcaNames.has(serverName))
    })
  )
  const added = adding.size > 0 ? withOrcaEntries(edit, before, adding) : before
  if (taken === null || (added !== null && mcpAgentFileServerNames(edit, added) === null)) {
    deps.log(`[mcp-servers] Orca's entries wouldn't fit ${path}, so it's left as it is`)
    return true
  }
  if (adding.size > 0 && added === null) {
    deps.log(`[mcp-servers] ${path} has no object to hold Orca's entries, so it's left as it is`)
    return true
  }
  // A file Orca made goes once nothing of the user's is in it.
  const next =
    added !== null && adding.size === 0 && created && isEmptyMcpAgentFile(edit, added)
      ? null
      : added
  if (next !== current && !(await publish(path, next, current))) {
    return false
  }
  await deps.ledger.set(
    path,
    next !== null && adding.size > 0
      ? {
          agent: edit.agent,
          created,
          addedTable: record?.addedTable ?? (before === null || !hasMcpServersTable(edit, before)),
          before,
          written: next,
          entries: Object.fromEntries(
            [...adding].map(([name, entry]) => [name, mcpAgentFileValue(edit.agent, entry)])
          )
        }
      : null
  )
  return true
}

/** Writes `next` (null deletes the file) only while the file still holds `current`. */
async function publish(
  path: string,
  next: string | null,
  current: string | null
): Promise<boolean> {
  if (current === null) {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, next ?? '', { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'EEXIST') {
        return false
      }
      throw error
    }
  }
  if (next === null) {
    if ((await readAgentConfigText(path)) !== current) {
      return false
    }
    await rm(path, { force: true })
    return true
  }
  return await writeAgentConfigIfUnchanged(path, next, current)
}

/** This app's CLI by absolute path, as its own terminals get it. */
function thisAppLauncher(userDataPath: string): string | null {
  return prependOrcaCliDirToChildPath(
    {},
    {
      isPackaged: getAppEnvironment().isPackaged(),
      userDataPath,
      resourcesPath: process.resourcesPath ?? null
    }
  )
}

/**
 * Syncs now and after every change to this host's list, one run at a time; a change during a run
 * runs it once more. Returns the stop.
 */
export function startMcpAgentFileSync(): () => void {
  const folder = mcpHostListFolder()
  const userDataPath = getAppEnvironment().getPath('userData')
  // Once: this run of Orca's launcher doesn't move.
  const launcher = thisAppLauncher(userDataPath)
  const deps = (): McpAgentFileSyncDeps => ({
    folder,
    userDataPath,
    launcher,
    context: { homeDir: homedir(), env: process.env, platform: process.platform },
    ledger: new McpAgentFileLedger(join(folder, '.orca', 'agent-files-ledger.json')),
    log: (message) => console.warn(message)
  })
  let running = false
  let again = false
  const run = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await syncMcpAgentFiles(deps()).catch((error: unknown) =>
          console.warn('[mcp-servers] couldn’t sync agents’ MCP files:', error)
        )
      } while (again)
    } finally {
      running = false
    }
  }
  const stop = onMcpHostListChanged(() => void run())
  void run()
  return stop
}
