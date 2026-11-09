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

/** Keep suppressed aliases so deleting a preferred path can promote the surviving source. */
export class SessionSearchCandidateInventory {
  private readonly groups = new Map<
    string,
    Map<string, { candidate: SessionFileCandidate; root: string }>
  >()
  private readonly byPath = new Map<string, Set<string>>()
  private readonly selected = new Map<string, Set<string>>()

  has(path: string): boolean {
    return this.byPath.has(path)
  }

  async update(
    discoveries: readonly SessionFileDiscovery[],
    removed: ReadonlySet<string>,
    options: AiVaultScanOptions,
    invalidated: ReadonlySet<string> = new Set()
  ): Promise<{ candidates: SessionFileCandidate[]; suppressed: Set<string>; forced: Set<string> }> {
    const changed = new Set<string>()
    const forced = new Set<string>()
    for (const path of removed) {
      for (const key of this.byPath.get(path) ?? []) {
        const group = this.groups.get(key)
        if (group) {
          for (const [id, row] of group) {
            if (row.candidate.file.path === path) {
              group.delete(id)
            }
          }
        }
        changed.add(key)
      }
      this.byPath.delete(path)
    }
    for (const discovery of discoveries) {
      for (const candidate of discoveryFileCandidates(discovery, discovery.files, options)) {
        const path = candidate.file.path
        const key =
          candidate.agent === 'codex'
            ? `codex:${sessionFileExecutionNamespace(path)}:${basename(path)}`
            : candidate.agent === 'antigravity'
              ? `antigravity:${dirname(path)}`
              : candidate.agent === 'opencode'
                ? `opencode:${sessionFileExecutionNamespace(path)}:${splitOpenCodeSqliteCandidate(path)?.sessionId ?? basename(path, extname(path))}`
                : path
        const group = this.groups.get(key) ?? new Map()
        if (candidate.agent === 'codex' && candidate.file.nlink && candidate.file.nlink > 1) {
          for (const row of group.values()) {
            const file = row.candidate.file
            if (file.dev === candidate.file.dev && file.ino === candidate.file.ino) {
              row.candidate = { ...row.candidate, file: { ...candidate.file, path: file.path } }
              if (invalidated.has(path)) {
                forced.add(file.path)
              }
            }
          }
        }
        group.set(`${candidate.agent}:${path}`, { candidate, root: discovery.rootDir })
        this.groups.set(key, group)
        const keys = this.byPath.get(path) ?? new Set()
        keys.add(key)
        this.byPath.set(path, keys)
        changed.add(key)
      }
    }
    const candidates: SessionFileCandidate[] = []
    const suppressed = new Set<string>()
    for (const key of changed) {
      const group = this.groups.get(key)!
      const rows = [...group.values()]
      const eligible = rows.some(
        (row) =>
          row.candidate.agent === 'opencode' &&
          splitOpenCodeSqliteCandidate(row.candidate.file.path)
      )
        ? rows.filter((row) => splitOpenCodeSqliteCandidate(row.candidate.file.path))
        : rows
      const selected = await sessionCandidatesFromDiscoveries(
        eligible.map(({ candidate, root }) => ({
          agent: candidate.agent,
          rootDir: root,
          files: [candidate.file]
        })),
        options
      )
      const paths = new Set(selected.map((candidate) => candidate.file.path))
      for (const path of this.selected.get(key) ?? []) {
        if (!paths.has(path)) {
          suppressed.add(path)
        }
      }
      this.selected.set(key, paths)
      candidates.push(...selected)
      if (group.size === 0) {
        this.groups.delete(key)
        this.selected.delete(key)
      }
    }
    return {
      candidates: candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs),
      suppressed,
      forced
    }
  }
}
