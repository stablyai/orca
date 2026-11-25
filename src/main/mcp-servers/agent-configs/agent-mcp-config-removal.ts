// Move to Orca's second half: take the moved entries out of the agents' own files. Edits are text
// splices (by the JSON parse tree, by lines for TOML), checked to change nothing else, then
// published only while the file still holds what the edit was made from, with a rolling `.bak`.
import { isDeepStrictEqual } from 'node:util'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import {
  readRawTomlConfig,
  writeTomlConfigAtomically
} from '../../codex/configuration/toml/config-toml-atomic-write'
import { ConcurrentFileEditError } from '../../filesystem/concurrent-file-edit-guard'
import {
  agentMcpConfigServersIn,
  parseAgentMcpConfigText,
  valueAtKeyPath,
  type AgentMcpConfigSource
} from './agent-mcp-config-read'
import { removeTomlMcpServers } from './toml-mcp-server-removal'
import { removeJsonProperty } from './json-property-removal'

export class AgentMcpConfigEditError extends Error {
  constructor(
    readonly reason: 'changed' | 'unparseable' | 'not-editable',
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
  const bom = raw.startsWith('﻿') ? '﻿' : ''
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
  const expected = parseAgentMcpConfigText(body, removing[0]!.format)
  for (const source of removing) {
    deleteKeyPath(expected, source.keyPath)
  }
  if (!isDeepStrictEqual(parseAgentMcpConfigText(edited, removing[0]!.format), expected)) {
    throw new AgentMcpConfigEditError('not-editable', path)
  }
  return bom + edited
}

type RemovalOptions = {
  /** `skip` leaves an entry whose definition differs; `refuse` stops at that file. */
  differing: 'refuse' | 'skip'
}

/**
 * Removes the entries of one discovered server (`mergeKey`) from every file in `sources`, keeping
 * a backup of each file's previous bytes beside it. Entries already gone are skipped. Returns the
 * files it changed.
 */
export function removeAgentMcpServerEntries(
  sources: readonly AgentMcpConfigSource[],
  mergeKey: string,
  options: RemovalOptions = { differing: 'refuse' }
): string[] {
  const byFile = new Map<string, AgentMcpConfigSource[]>()
  for (const source of sources) {
    if (source.scope !== 'user') {
      throw new AgentMcpConfigEditError('not-editable', source.path)
    }
    byFile.set(source.path, [...(byFile.get(source.path) ?? []), source])
  }
  const changed: string[] = []
  for (const [path, fileSources] of byFile) {
    let published = false
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS && !published; attempt++) {
      const raw = readRawTomlConfig(path)
      const next = raw === null ? null : removalFrom(raw, fileSources, mergeKey, options.differing)
      if (next === null) {
        published = true
      } else if (writeTomlConfigAtomically(path, next, raw, { backup: true })) {
        changed.push(path)
        published = true
      }
    }
    if (!published) {
      throw new ConcurrentFileEditError(path)
    }
  }
  return changed
}
