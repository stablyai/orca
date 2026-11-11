import type { OrchestrationDb } from '../db/orchestration-db'
import { paneKeyMatchSuffix } from '../db/pane-key-match'
import {
  readWorkerAttentionInputs,
  projectWorkerAttentionInput
} from '../db/worker-terminal/worker-terminal-attention-query'
import {
  installProjectionInvalidations,
  projectionDirtyKeys,
  trackProjectionKey
} from './orchestration-projection-invalidations'
import { projectionNeedsRebuild, acknowledgeProjectionDebt } from './orchestration-projection-debt'
import { PresentationDispatchIndex } from './presentation-dispatch-index'
import { withPresentationCompletionSource } from '../db/dispatch-context/presentation-completion-source'
type Fact = { value: unknown; dependencies: readonly string[]; owners: Set<string> }
const sources = new WeakMap<OrchestrationDb, OrchestrationProjectionFacts>()
const views = new WeakMap<OrchestrationDb, OrchestrationProjectionFacts>()

/** The connection owns persisted facts; every presentation still reads live identities and time. */
export class OrchestrationProjectionFacts {
  readonly view: OrchestrationDb
  private readonly candidates: PresentationDispatchIndex
  private readonly facts = new Map<string, Fact>()
  private readonly dependencies = new Map<string, Set<string>>()
  private readonly owned = new Map<string, Set<string>>()
  private owner: string | undefined
  private version: unknown
  private revision: number | undefined
  private cold = true
  private previousNow = -Infinity

  constructor(
    private readonly db: OrchestrationDb,
    private readonly transient = false
  ) {
    this.candidates = new PresentationDispatchIndex(
      db,
      (owner, key, dependencies, read) =>
        this.withDispatch(owner, () => this.memo(key, dependencies, read)),
      (id) => this.release(id)
    )
    if (!transient) {
      installProjectionInvalidations(db)
    }
    // This facade is used only by projection readers; mutations and admission retain the real DB.
    this.view = Object.create(db, {
      getActiveDispatchForTerminal: {
        value: (handle: string, pane?: string) => this.candidates.activeFor(handle, pane)
      },
      getLatestDispatchForTerminal: { value: (handle: string) => this.candidates.latest(handle) },
      getTask: {
        value: (id: string, run?: string) =>
          this.memo(
            `task:${id}:${run ?? ''}`,
            [`task:${id}`],
            () => (run === undefined ? db.getTask(id) : db.getTask(id, run)),
            (task) =>
              task?.created_by_terminal_handle ? [`handle:${task.created_by_terminal_handle}`] : []
          )
      },
      getRun: { value: (id: string) => this.memo(`run:${id}`, [`run:${id}`], () => db.getRun(id)) },
      runsBoundToPane: {
        value: (pane: string) =>
          this.memo(`bound:${pane}`, [`bound:${paneKeyMatchSuffix(pane)}`], () =>
            db.runsBoundToPane(pane)
          )
      },
      getActiveCoordinatorRun: {
        value: () => this.memo('legacy', ['legacy'], () => db.getActiveCoordinatorRun())
      },
      getWorkerTerminalResourceByHandle: {
        value: (handle: string) =>
          this.memo(`resource-handle:${handle}`, [`resource-handle:${handle}`], () =>
            db.getWorkerTerminalResourceByHandle(handle)
          )
      },
      getWorkerTerminalResourceByProcessIncarnation: {
        value: (process: string) =>
          this.memo(`resource-process:${process}`, [`resource-process:${process}`], () =>
            db.getWorkerTerminalResourceByProcessIncarnation(process)
          )
      },
      hasRecordedStructuredWorkerSession: {
        value: (session: string, process: string) =>
          this.memo(`recorded:${session}:${process}`, [`session:${session}`], () =>
            db.hasRecordedStructuredWorkerSession(session, process)
          )
      },
      getWorkerAttentionFactsForDispatches: {
        value: (ids: readonly string[], now: number) => this.attention(ids, now)
      },
      getWorkerAttentionFacts: {
        value: (id: string, now: number) => {
          const result = this.attention([id], now).get(id)
          if (!result) {
            throw new Error(`Dispatch ${id} was not found.`)
          }
          return result
        }
      },
      listSessionDispatchesForPresentation: {
        value: (now: number, sessions?: readonly string[]) =>
          this.candidates.sessions(now, sessions)
      }
    })
    views.set(this.view, this)
  }

  refresh(now: number): void {
    try {
      withPresentationCompletionSource(this.db.db, now, ({ version, revision }) => {
        const overflow = !this.transient && projectionNeedsRebuild(this.db)
        const cold =
          this.cold ||
          version !== this.version ||
          revision !== this.revision ||
          now < this.previousNow ||
          overflow
        if (cold) {
          this.reset()
        }
        const previousSize = this.candidates.size
        const dirty = this.transient || cold ? [] : projectionDirtyKeys(this.db)
        const affected = new Set<string>()
        for (const key of dirty) {
          for (const factKey of this.dependencies.get(key) ?? []) {
            for (const owner of this.facts.get(factKey)?.owners ?? []) {
              affected.add(owner)
            }
          }
        }
        for (const owner of affected) {
          this.release(owner)
        }
        this.candidates.refresh(now, dirty, cold)
        if (
          !this.transient &&
          (cold || dirty.length > 0 || this.candidates.size !== previousSize)
        ) {
          acknowledgeProjectionDebt(this.db, this.candidates.size)
        }
        this.cold = false
        this.version = version
        this.revision = revision
        this.previousNow = now
      })
    } catch (error) {
      // A retry discards partial indexes before consuming the still-unacknowledged obligation.
      this.cold = true
      throw error
    }
  }

  rows(): ReturnType<PresentationDispatchIndex['rows']> {
    return this.candidates.rows()
  }

  withDispatch<T>(id: string, read: () => T): T {
    const previous = this.owner
    this.owner = id
    try {
      return read()
    } finally {
      this.owner = previous
    }
  }

  private attention(ids: readonly string[], now: number) {
    const missing = ids.filter((id) => !this.facts.has(`attention:${id}`))
    if (missing.length) {
      for (const [id, input] of readWorkerAttentionInputs(this.db, missing)) {
        this.withDispatch(id, () =>
          this.memo(`attention:${id}`, [`dispatch:${id}`, `task:${input.row.task_id}`], () => input)
        )
      }
    }
    return new Map(
      ids.flatMap((id) => {
        const fact = this.facts.get(`attention:${id}`)
        return fact
          ? [
              [
                id,
                projectWorkerAttentionInput(
                  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attention entries are populated only from readWorkerAttentionInputs above.
                  fact.value as Parameters<typeof projectWorkerAttentionInput>[0],
                  now
                )
              ] as const
            ]
          : []
      })
    )
  }

  private memo<T>(
    key: string,
    dependencies: readonly string[],
    read: () => T,
    valueDependencies?: (value: T) => readonly string[]
  ): T {
    let fact = this.facts.get(key)
    if (!this.owner || !this.candidates.has(this.owner)) {
      return read()
    }
    if (!fact) {
      const value = read()
      dependencies = [...dependencies, ...(valueDependencies?.(value) ?? [])]
      fact = { value, dependencies, owners: new Set() }
      this.facts.set(key, fact)
      for (const dependency of dependencies) {
        const keys = this.dependencies.get(dependency) ?? new Set()
        if (keys.size === 0 && !this.transient) {
          trackProjectionKey(this.db, dependency, true)
        }
        keys.add(key)
        this.dependencies.set(dependency, keys)
      }
    }
    fact.owners.add(this.owner)
    const keys = this.owned.get(this.owner) ?? new Set()
    keys.add(key)
    this.owned.set(this.owner, keys)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each concrete domain key is written by one typed read function.
    return fact.value as T
  }

  private forget(key: string): void {
    const fact = this.facts.get(key)
    if (!fact) {
      return
    }
    for (const owner of fact.owners) {
      this.owned.get(owner)?.delete(key)
    }
    for (const dependency of fact.dependencies) {
      const keys = this.dependencies.get(dependency)
      keys?.delete(key)
      if (keys?.size === 0) {
        this.dependencies.delete(dependency)
        if (!this.transient) {
          trackProjectionKey(this.db, dependency, false)
        }
      }
    }
    this.facts.delete(key)
  }

  private release(id: string): void {
    for (const key of this.owned.get(id) ?? []) {
      const fact = this.facts.get(key)
      fact?.owners.delete(id)
      if (fact?.owners.size === 0) {
        this.forget(key)
      }
    }
    this.owned.delete(id)
  }

  private reset(): void {
    if (!this.transient) {
      // Rollback can restore SQL memberships after a failed refresh cleared the JS owners.
      this.db.db.prepare('DELETE FROM temp.orchestration_projection_tracked').run()
    }
    this.facts.clear()
    this.dependencies.clear()
    this.candidates.clear()
    this.owned.clear()
    this.cold = true
  }
}

export function orchestrationProjectionFacts(
  db: OrchestrationDb,
  now = Date.now()
): OrchestrationProjectionFacts | undefined {
  const view = views.get(db)
  if (view) {
    return view
  }
  let source = db.db.isTransaction ? undefined : sources.get(db)
  if (!source) {
    // An uncached probe also sees raw/local and external inserts after an empty read.
    if (!db.db.prepare('SELECT 1 FROM dispatch_contexts LIMIT 1').get()) {
      return undefined
    }
    source = new OrchestrationProjectionFacts(db, db.db.isTransaction)
    if (!db.db.isTransaction) {
      sources.set(db, source)
    }
  }
  source.refresh(now)
  return source
}
