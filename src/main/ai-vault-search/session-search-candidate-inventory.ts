import {
  SessionSearchCandidatePublications,
  rows,
  type Row
} from './session-search-candidate-publication'
import { splitOpenCodeSqliteCandidate } from '../../shared/opencode-sqlite-session-path'
import { basename, dirname, extname } from 'node:path'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import {
  discoveryFileCandidates,
  sessionCandidatesFromDiscoveries
} from '../ai-vault/session-scanner-candidates'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../ai-vault/session-scanner-types'

function rowId(row: Row): string {
  return `${row.candidate.agent}:${row.candidate.file.path}`
}
function groupKey(candidate: SessionFileCandidate, root: string): string {
  const path = candidate.file.path
  return candidate.agent === 'codex'
    ? `codex:${sessionFileExecutionNamespace(path)}:${basename(path)}`
    : candidate.agent === 'antigravity'
      ? `antigravity:${dirname(path)}`
      : candidate.agent === 'opencode' ||
          candidate.agent === 'opencode2' ||
          candidate.agent === 'zcode'
        ? `${candidate.agent}:${root}:${splitOpenCodeSqliteCandidate(path, candidate.agent)?.sessionId ?? basename(path, extname(path))}`
        : path
}

/** Ordinary paths own one record; only competing aliases allocate a group and selected set. */
export class SessionSearchCandidateInventory extends SessionSearchCandidatePublications {
  private readonly sourceOrders = new Map<string, ReadonlyMap<string, number>>()
  rootFor(candidate: SessionFileCandidate): string | undefined {
    const owner = this.byPath.get(candidate.file.path)
    for (const key of typeof owner === 'string' ? [owner] : (owner ?? [])) {
      const row = rows(this.groups.get(key)).find(
        (row) =>
          row.candidate.agent === candidate.agent && row.candidate.file.path === candidate.file.path
      )
      if (row) {
        return row.root
      }
    }
    return undefined
  }
  has(path: string, agent?: string | null): boolean {
    const owner = this.byPath.get(path)
    if (!agent) {
      return owner !== undefined
    }
    return (typeof owner === 'string' ? [owner] : [...(owner ?? [])]).some((key) =>
      rows(this.groups.get(key)).some(
        (row) => row.candidate.file.path === path && row.candidate.agent === agent
      )
    )
  }
  async update(
    discoveries: readonly SessionFileDiscovery[],
    removed: ReadonlySet<string>,
    options: AiVaultScanOptions,
    invalidated: ReadonlySet<string> = new Set(),
    removedCandidates: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
    partial = false
  ): Promise<{ candidates: SessionFileCandidate[]; suppressed: Set<string>; forced: Set<string> }> {
    const scopes = new Set(
      discoveries.map((discovery) => `${discovery.agent}:${discovery.rootDir}`)
    )
    for (const scope of this.sourceOrders.keys()) {
      if (!partial && !scopes.has(scope)) {
        this.sourceOrders.delete(scope)
      }
    }
    const previous = new Map<string, Set<string>>()
    const affectedPaths = new Set<string>()
    const forced = new Set<string>()
    const touch = (key: string) => {
      if (previous.has(key)) {
        return
      }
      const group = this.groups.get(key)
      for (const { candidate } of rows(group)) {
        affectedPaths.add(candidate.file.path)
      }
      previous.set(
        key,
        this.selected.get(key) ??
          new Set(group && !(group instanceof Map) ? [group.candidate.file.path] : [])
      )
    }
    for (const path of new Set([...removed, ...removedCandidates.keys()])) {
      const owner = this.byPath.get(path)
      for (const key of typeof owner === 'string' ? [owner] : (owner ?? [])) {
        touch(key)
        const remaining = rows(this.groups.get(key)).filter(
          (row) =>
            row.candidate.file.path !== path ||
            (!removed.has(path) && !removedCandidates.get(path)?.has(row.candidate.agent))
        )
        if (remaining.length === 0) {
          this.groups.delete(key)
        } else if (remaining.length === 1) {
          this.groups.set(key, remaining[0])
        } else {
          this.groups.set(key, new Map(remaining.map((row) => [rowId(row), row])))
        }
      }
      const retained = new Set(
        (typeof owner === 'string' ? [owner] : [...(owner ?? [])]).filter((key) =>
          rows(this.groups.get(key)).some((row) => row.candidate.file.path === path)
        )
      )
      if (retained.size === 0) {
        this.byPath.delete(path)
      } else {
        this.byPath.set(path, retained.size === 1 ? retained.values().next().value! : retained)
      }
    }
    for (const discovery of discoveries) {
      const scope = `${discovery.agent}:${discovery.rootDir}`
      if (discovery.sourceOrder && this.sourceOrders.get(scope) !== discovery.sourceOrder) {
        this.sourceOrders.set(scope, discovery.sourceOrder)
        for (const key of this.selected.keys()) {
          if (
            rows(this.groups.get(key)).some((row) => `${row.candidate.agent}:${row.root}` === scope)
          ) {
            touch(key)
          }
        }
      }
      for (const candidate of discoveryFileCandidates(discovery, discovery.files, options)) {
        const path = candidate.file.path,
          key = groupKey(candidate, discovery.rootDir)
        touch(key)
        const group = this.groups.get(key)
        if (candidate.agent === 'codex' && candidate.file.nlink && candidate.file.nlink > 1) {
          for (const row of rows(group)) {
            const file = row.candidate.file
            if (file.dev === candidate.file.dev && file.ino === candidate.file.ino) {
              row.candidate = { ...row.candidate, file: { ...candidate.file, path: file.path } }
              if (invalidated.has(path)) {
                forced.add(file.path)
              }
            }
          }
        }
        const row = { candidate, root: discovery.rootDir }
        if (!group) {
          this.groups.set(key, row)
        } else if (group instanceof Map) {
          group.set(rowId(row), row)
        } else if (rowId(group) === rowId(row)) {
          this.groups.set(key, row)
        } else {
          this.groups.set(
            key,
            new Map([
              [rowId(group), group],
              [rowId(row), row]
            ])
          )
        }
        const owner = this.byPath.get(path)
        if (!owner) {
          this.byPath.set(path, key)
        } else if (typeof owner === 'string') {
          if (owner !== key) {
            this.byPath.set(path, new Set([owner, key]))
          }
        } else {
          owner.add(key)
        }
      }
    }
    const candidates: SessionFileCandidate[] = [],
      suppressed = new Set<string>()
    for (const [key, oldPaths] of previous) {
      const group = this.groups.get(key)
      const members = rows(group)
      const eligible = members.some((row) =>
        splitOpenCodeSqliteCandidate(
          row.candidate.file.path,
          row.candidate.agent === 'zcode' ? 'zcode' : 'opencode'
        )
      )
        ? members.filter((row) =>
            splitOpenCodeSqliteCandidate(
              row.candidate.file.path,
              row.candidate.agent === 'zcode' ? 'zcode' : 'opencode'
            )
          )
        : members
      eligible.sort((left, right) => {
        const rank = (row: Row) => {
          const source = splitOpenCodeSqliteCandidate(
            row.candidate.file.path,
            row.candidate.agent === 'zcode' ? 'zcode' : 'opencode'
          )
          return source
            ? (this.sourceOrders.get(`${row.candidate.agent}:${row.root}`)?.get(source.dbPath) ??
                Infinity)
            : Infinity
        }
        return (
          right.candidate.file.mtimeMs - left.candidate.file.mtimeMs || rank(left) - rank(right)
        )
      })
      const ranked = await sessionCandidatesFromDiscoveries(
        eligible.map(({ candidate, root }) => ({
          agent: candidate.agent,
          rootDir: root,
          files: [candidate.file]
        })),
        options
      )
      // Each database source originally chose greatest mtime, with source order breaking ties.
      const selected = eligible.some((row) =>
        splitOpenCodeSqliteCandidate(
          row.candidate.file.path,
          row.candidate.agent === 'zcode' ? 'zcode' : 'opencode'
        )
      )
        ? ranked.slice(0, 1)
        : ranked
      const paths = new Set(selected.map((candidate) => candidate.file.path))
      for (const path of oldPaths) {
        if (!paths.has(path)) {
          suppressed.add(path)
        }
      }
      if (group instanceof Map) {
        this.selected.set(key, paths)
      } else {
        this.selected.delete(key)
      }
      candidates.push(...selected)
    }
    this.updatePublications(previous, affectedPaths)
    for (const path of suppressed) {
      const owner = this.byPath.get(path)
      if (
        (typeof owner === 'string' ? [owner] : [...(owner ?? [])]).some((key) => {
          const group = this.groups.get(key)
          return group instanceof Map
            ? this.selected.get(key)?.has(path)
            : group?.candidate.file.path === path
        })
      ) {
        suppressed.delete(path)
      }
    }
    candidates.sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
    return { candidates, suppressed, forced }
  }
}
