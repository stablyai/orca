import type {
  SessionSearchCandidateBatchRow,
  SessionSearchDiscoveryTransfer
} from './session-search-catalog-candidate-types'
import type { SessionSearchContainerRemoval } from './session-search-container-transition'
import type { SessionSearchRemovalReceipt } from './session-search-observation-authority'
import type { SessionSearchCandidateCommand } from './session-search-catalog-candidates'
import type { SessionSearchWorkResult } from './session-search-work-queue'
import { sessionSearchRecordPages } from './session-search-catalog-pages'
import type { SessionSearchIndexStore } from './storage/session-search-store-types'
import { SessionSearchCandidatePublications } from './session-search-candidate-publication'
import { splitOpenCodeSqliteCandidate } from '../../shared/opencode-sqlite-session-path'
import { basename } from 'node:path'
import { sessionSearchCandidateGroup } from './session-search-candidate-group'
import { discoveryFileCandidates } from '../ai-vault/session-scanner-candidates'
import { readCodexRolloutSessionMetaId } from '../codex/history/rollouts/codex-rollout-session-meta'
import {
  codexRolloutHardlinkIdentity,
  codexSessionRootRank
} from '../ai-vault/scanners/codex/codex-session-root-dedup'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../ai-vault/session-scanner-types'

/** Bounded projections of the raw candidates; the archive never lives in this isolate. */
export class SessionSearchCandidateInventory extends SessionSearchCandidatePublications {
  constructor(store?: SessionSearchIndexStore) {
    super()
    if (store) {
      this.attach(store)
    }
  }
  private readonly sourceOrders = new Map<string, ReadonlyMap<string, number>>()
  override reset(): void {
    super.reset()
    this.sourceOrders.clear()
  }
  async changedForRoot(root: string, agent: string) {
    return (await this.request!({ kind: 'changes', root, agent })).rows
  }
  async admitChanges(
    receipts: { key: string; revision: number }[],
    recent: boolean,
    recovering: boolean,
    read?: Extract<SessionSearchCandidateCommand, { kind: 'admit' }>['read']
  ) {
    const response = await this.request!({
      kind: 'admit',
      read,
      recent,
      recovering,
      rows: receipts
    })
    return { ...response.work!, scopeCounts: response.scopeCounts }
  }
  async acknowledgeChanges(receipts: { key: string; revision: number }[]): Promise<void> {
    for (const row of receipts) {
      await this.request!({ kind: 'consumed', ...row })
    }
  }
  async remove(
    paths: ReadonlySet<string>,
    agents: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
    observations: ReadonlyMap<string, SessionSearchRemovalReceipt> = new Map(),
    containers: ReadonlyMap<string, SessionSearchContainerRemoval[]> = new Map()
  ) {
    let work
    const rows = [...new Set([...paths, ...agents.keys()])].map((path) => ({
      path,
      agents: paths.has(path) ? undefined : [...agents.get(path)!],
      observation: observations.get(path),
      containers: containers.get(path)
    }))
    for (const page of sessionSearchRecordPages(rows)) {
      for (const row of page) {
        this.invalidate(row.path)
      }
      work = (await this.request!({ kind: 'remove-page', rows: page })).work
    }
    return work
  }
  async update(
    discoveries: readonly SessionFileDiscovery[],
    removed: ReadonlySet<string>,
    options: AiVaultScanOptions,
    invalidated: ReadonlySet<string> = new Set(),
    removedCandidates: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
    partial = false,
    metadata: ReadonlySet<string> = new Set(),
    containerRemovals: ReadonlyMap<string, SessionSearchContainerRemoval[]> = new Map(),
    transfer?: SessionSearchDiscoveryTransfer
  ): Promise<{
    receipts: { key: string; revision: number }[]
    candidates: SessionFileCandidate[]
    suppressed: Set<string>
    forced: Set<string>
    metadata: Set<string>
    work?: SessionSearchWorkResult
    transferred?: boolean
    scopeCounts?: [string, number, number][]
  }> {
    if (!this.request) {
      throw new Error('Session candidate catalog is not attached')
    }
    const scopes = new Set(
      discoveries.map((discovery) => `${discovery.agent}:${discovery.rootDir}`)
    )
    for (const scope of this.sourceOrders.keys()) {
      if (!partial && !scopes.has(scope)) {
        this.sourceOrders.delete(scope)
      }
    }
    let work = await this.remove(removed, removedCandidates, new Map(), containerRemovals)
    const rows: SessionSearchCandidateBatchRow[] = []
    for (const discovery of discoveries) {
      const projected = discoveryFileCandidates(discovery, discovery.files, options)
      const eligible = projected.filter(
        (candidate) =>
          candidate.agent === 'codex' && /^rollout-.+\.jsonl$/.test(basename(candidate.file.path))
      )
      const contestedPaths = new Set(
        eligible.length
          ? (
              await this.request({
                kind: 'contested',
                rows: eligible.map((candidate) => ({
                  group: sessionSearchCandidateGroup(candidate, discovery.rootDir),
                  path: candidate.file.path
                }))
              })
            ).contested
          : []
      )
      const scope = `${discovery.agent}:${discovery.rootDir}`
      if (discovery.sourceOrder && this.sourceOrders.get(scope) !== discovery.sourceOrder) {
        this.sourceOrders.set(scope, discovery.sourceOrder)
        let after: string | undefined
        do {
          after = (
            await this.request({
              kind: 'rerank',
              root: discovery.rootDir,
              agent: discovery.agent,
              order: [...discovery.sourceOrder],
              after
            })
          ).after
        } while (after !== undefined)
      }
      for (const candidate of projected) {
        this.invalidate(candidate.file.path)
        const group = sessionSearchCandidateGroup(candidate, discovery.rootDir)
        const source = splitOpenCodeSqliteCandidate(
          candidate.file.path,
          candidate.agent === 'zcode' ? 'zcode' : 'opencode'
        )
        let alias = `${candidate.agent}:${candidate.file.path}`
        if (candidate.agent === 'pi' || candidate.agent === 'omp') {
          alias = candidate.file.path
        }
        const codex =
          candidate.agent === 'codex' && /^rollout-.+\.jsonl$/.test(basename(candidate.file.path))
        if (codex) {
          alias = codexRolloutHardlinkIdentity(candidate.file) ?? alias
          if (contestedPaths.has(candidate.file.path)) {
            let page = await this.request({ kind: 'group', group })
            do {
              for (const row of page.rows) {
                if (row.candidate.file.path === candidate.file.path) {
                  continue
                }
                const hardlink = codexRolloutHardlinkIdentity(candidate.file)
                const shared =
                  hardlink && codexRolloutHardlinkIdentity(row.candidate.file) === hardlink
                const sibling = shared
                  ? { ...row.candidate, file: { ...candidate.file, path: row.candidate.file.path } }
                  : row.candidate
                const id = await readCodexRolloutSessionMetaId(
                  sibling.file.path,
                  options.signal,
                  'scan'
                )
                await this.request({
                  kind: 'put',
                  row: {
                    ...row,
                    candidate: sibling,
                    alias: id
                      ? `copy:${id}`
                      : (codexRolloutHardlinkIdentity(sibling.file) ??
                        `${sibling.agent}:${sibling.file.path}`)
                  }
                })
                if (shared && invalidated.has(candidate.file.path)) {
                  await this.requirePublication(sibling.file.path, 'force')
                }
              }
              const after = page.rows.at(-1)?.key
              page = after
                ? await this.request({ kind: 'group', group, after })
                : { ...page, rows: [] }
            } while (page.rows.length)
            const id = await readCodexRolloutSessionMetaId(
              candidate.file.path,
              options.signal,
              'scan'
            )
            if (id) {
              alias = `copy:${id}`
            }
          }
        }
        rows.push({
          candidate,
          input: transfer?.inputs.get(candidate.file.path),
          root: discovery.rootDir,
          group,
          alias,
          sqlite: source !== null,
          sourcePath: source?.dbPath,
          preference:
            candidate.agent === 'codex'
              ? codexSessionRootRank(candidate.codexHome)
              : candidate.agent === 'omp'
                ? 1
                : 0,
          sourceOrder: source
            ? (this.sourceOrders.get(scope)?.get(source.dbPath) ?? Number.MAX_SAFE_INTEGER)
            : 0,
          force: invalidated.has(candidate.file.path),
          metadata: metadata.has(candidate.file.path)
        })
      }
    }
    const scopeCounts: [string, number, number][] = []
    for (const page of sessionSearchRecordPages(rows)) {
      const response = await this.request({
        kind: 'batch',
        rows: page,
        admission: transfer
          ? { recent: transfer.recent, recovering: transfer.recovering }
          : undefined
      })
      work = response.work ?? work
      scopeCounts.push(...(response.scopeCounts ?? []))
    }
    if (transfer) {
      return {
        work,
        scopeCounts,
        transferred: true,
        receipts: [],
        candidates: [],
        suppressed: new Set(),
        forced: new Set(),
        metadata: new Set()
      }
    }
    const changed = await this.request({ kind: 'changes' })
    const suppressed = new Set(
      changed.rows
        .filter((row) => !row.selected && !row.protectedPath)
        .map((row) => row.candidate.file.path)
    )
    return {
      work,
      receipts: changed.rows.map(({ key, revision }) => ({ key, revision })),
      candidates: changed.rows
        .filter((row) => row.selected)
        .map((row) => row.candidate)
        .sort(
          (left, right) =>
            (right.file.aliasMtimeMs ?? right.file.mtimeMs) -
              (left.file.aliasMtimeMs ?? left.file.mtimeMs) ||
            Number(right.file.path.endsWith('transcript_full.jsonl')) -
              Number(left.file.path.endsWith('transcript_full.jsonl'))
        ),
      suppressed,
      forced: new Set(
        changed.rows.filter((row) => row.forced).map((row) => row.candidate.file.path)
      ),
      metadata: new Set(
        changed.rows.filter((row) => row.metadata).map((row) => row.candidate.file.path)
      )
    }
  }
}
