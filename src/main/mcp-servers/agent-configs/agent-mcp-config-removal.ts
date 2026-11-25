// Move to Orca's second half: take the moved entries out of the agents' own files. Edits are text
// splices (by the JSON parse tree, by lines for TOML), checked to change nothing else, then
// published only while the file still holds what the edit was made from, with a rolling `.bak`.
import { isDeepStrictEqual } from 'node:util'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import { ConcurrentFileEditError } from '../../filesystem/concurrent-file-edit-guard'
import {
  agentMcpConfigServersIn,
  parseAgentMcpConfigText,
  valueAtKeyPath,
  type AgentMcpConfigSource
} from './agent-mcp-config-read'
import { removeTomlMcpServers } from './toml-mcp-server-removal'
import { removeJsonProperty } from './json-property-removal'
import { readAgentConfigText, writeAgentConfigIfUnchanged } from './agent-config-file-write'
import { withClaudeGlobalConfigLock } from '../../claude/configuration/claude-global-config-lock'

export class AgentMcpConfigEditError extends Error {
  constructor(
    readonly reason: 'changed' | 'unparseable' | 'not-editable' | 'locked',
    readonly path: string
  ) {
    super(`${path}: ${reason}`)
    this.name = 'AgentMcpConfigEditError'
  }
}

const PUBLISH_ATTEMPTS = 3

function deleteKeyPath(root: unknown, path: readonly string[]): void {
  const parent = valueAtKeyPath(root, path.slice(0, -1))
  if (typeof parent === 'object' && parent !== null) {
    Reflect.deleteProperty(parent, path.at(-1) ?? '')
  }
}

/**
 * `expected` minus the removed entries, and minus the tables that held only them when the edit
 * dropped those too: a TOML file whose last `[mcp_servers.x]` goes has no `mcp_servers` left.
 */
function withoutRemoved(
  expected: unknown,
  actual: unknown,
  removed: readonly (readonly string[])[]
): unknown {
  for (const path of removed) {
    deleteKeyPath(expected, path)
    for (let depth = path.length - 1; depth > 0; depth--) {
      const parentPath = path.slice(0, depth)
      const parent = valueAtKeyPath(expected, parentPath)
      const emptied =
        typeof parent === 'object' && parent !== null && Object.keys(parent).length === 0
      if (!emptied || valueAtKeyPath(actual, parentPath) !== undefined) {
        break
      }
      deleteKeyPath(expected, parentPath)
    }
  }
  return expected
}

function editedText(body: string, sources: readonly AgentMcpConfigSource[]): string | null {
  if (sources[0]?.format === 'toml') {
    const names = new Set(sources.map((source) => source.keyPath[1] ?? ''))
    return removeTomlMcpServers(body, sources[0].keyPath[0] ?? '', names)
  }
  return sources.reduce((text, source) => removeJsonProperty(text, source.keyPath), body)
}

/** The file's new text, or null when none of the entries is there any more. */
function removalFrom(
  raw: string,
  sources: readonly AgentMcpConfigSource[],
  mergeKey: string,
  differing: RemovalOptions['differing']
): string | null {
  const path = sources[0]!.path
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = raw.slice(bom.length)
  const current = agentMcpConfigServersIn(sources[0]!, raw)
  if (!current) {
    throw new AgentMcpConfigEditError('unparseable', path)
  }
  const wanted = new Set(sources.map((source) => JSON.stringify(source.keyPath)))
  const listed = current.filter((found) => wanted.has(JSON.stringify(found.source.keyPath)))
  const present = listed.filter(
    (found) => agentMcpServerMergeKey(found.configName, found.server) === mergeKey
  )
  // The user edited the entry since it was listed: moving it now would drop their change.
  if (present.length < listed.length && differing === 'refuse') {
    throw new AgentMcpConfigEditError('changed', path)
  }
  if (present.length === 0) {
    return null
  }
  const removing = present.map((found) => found.source)
  const edited = editedText(body, removing)
  if (edited === null) {
    throw new AgentMcpConfigEditError('not-editable', path)
  }
  // The splice must leave exactly the parsed config minus these entries.
  const format = removing[0]!.format
  const actual = parseAgentMcpConfigText(edited, format)
  const expected = withoutRemoved(
    parseAgentMcpConfigText(body, format),
    actual,
    removing.map((source) => source.keyPath)
  )
  if (!isDeepStrictEqual(actual, expected)) {
    throw new AgentMcpConfigEditError('not-editable', path)
  }
  return bom + edited
}

type RemovalOptions = {
  /** `skip` leaves an entry whose definition differs; `refuse` stops at that file. */
  differing: 'refuse' | 'skip'
}

/** Edits one file until it publishes; false when another writer kept changing it. */
async function removeFromFile(
  path: string,
  sources: readonly AgentMcpConfigSource[],
  mergeKey: string,
  differing: RemovalOptions['differing']
): Promise<boolean> {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    const raw = await readAgentConfigText(path)
    const next = raw === null ? null : removalFrom(raw, sources, mergeKey, differing)
    if (raw === null || next === null) {
      return false
    }
    if (await writeAgentConfigIfUnchanged(path, next, raw)) {
      return true
    }
  }
  throw new ConcurrentFileEditError(path)
}

/**
 * Removes the entries of one discovered server (`mergeKey`, its whole definition) from every file
 * in `sources`, keeping a backup of each file's previous bytes beside it. Entries already gone are
 * skipped. Claude's files are edited under Claude's own lock. Returns the files it changed.
 */
export async function removeAgentMcpServerEntries(
  sources: readonly AgentMcpConfigSource[],
  mergeKey: string,
  options: RemovalOptions = { differing: 'refuse' }
): Promise<string[]> {
  const byFile = new Map<string, AgentMcpConfigSource[]>()
  for (const source of sources) {
    if (source.scope !== 'user') {
      throw new AgentMcpConfigEditError('not-editable', source.path)
    }
    byFile.set(source.path, [...(byFile.get(source.path) ?? []), source])
  }
  const changed: string[] = []
  for (const [path, fileSources] of byFile) {
    const edit = (): Promise<boolean> =>
      removeFromFile(path, fileSources, mergeKey, options.differing)
    const outcome =
      fileSources[0]!.agent === 'claude'
        ? await withClaudeGlobalConfigLock(path, edit)
        : await edit()
    if (outcome === 'locked') {
      throw new AgentMcpConfigEditError('locked', path)
    }
    if (outcome) {
      changed.push(path)
    }
  }
  return changed
}
