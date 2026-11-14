import { resolveAgentModelCatalogAccount } from './agent-model-catalog-account-resolution'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadRecords } from './agent-model-catalog-running-account'
import {
  agentModelCatalogDefaultFollowsAccount,
  agentModelCatalogListedDefault
} from './agent-model-catalog-workspace'
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-scoped-lister'
import { seedAccountList } from './agent-model-catalog-account-list'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'
import {
  agentModelCatalogReleasedOwner,
  bindAgentModelCatalogScope,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import type { AgentModelCatalogReadOperation } from './agent-model-catalog-operation'

/** What a refresh resolves, captured when it starts; no reader's session, deadline or callback. */
export type AgentModelCatalogLaunch = {
  agent: string
  records: AgentModelCatalogReadRecords
  workspacePath?: string | null
  inSessionWorkspace?: true
  legacy?: boolean
  /** Resolves saved scope only and lists nothing (a saved-only read, or a deleted chat's). */
  passive: boolean
  bindingKey: string
  identity: string
}

export type AgentModelCatalogRefresh = {
  current: () => boolean
  /** Its scope is bound and the listing it found started (or none was due), or it ended. */
  listing: Promise<void>
  /** The folder's default settings reached its binding, or it ended. */
  defaults: Promise<void>
  /** Its listing ingested and the account's list seeded, or it ended. */
  done: Promise<void>
  hold: (reader: AgentModelCatalogReadOperation) => void
  /** Also lists efforts for a reader's selected model. */
  want: (model: string | undefined) => void
}

type Held = AgentModelCatalogRefresh & { workspaceId?: string; end: () => void }

/** Equivalent requests share one refresh that belongs to no reader. It ends when it finishes, at
 *  on its agent's or workspace's retirement, or with the service; readers only
 *  wait on it, each until its own deadline or cancellation, and never extend or end it. */
export function createAgentModelCatalogRefreshes(context: {
  deps: AgentModelCatalogServiceDeps
  lifetime: AbortSignal
  admission: PrioritySemaphore
  bindings: Map<string, AgentModelCatalogBinding>
  requestKey: (params: AgentModelCatalogReadParams) => string
  tasks: Set<Promise<unknown>>
}) {
  const { deps, lifetime, admission, bindings, requestKey, tasks } = context
  const refreshes = new Map<string, Held>()
  const start = (key: string, launch: AgentModelCatalogLaunch): Held => {
    const { agent } = launch
    const retirement = deps.store.retirementRevision(agent)
    const ended = new AbortController()
    // Scope work belongs to the host, independent of reader deadlines.
    const signal = AbortSignal.any([lifetime, ended.signal, deps.store.retirements.signal(agent)])
    const current = (): boolean =>
      !signal.aborted && deps.store.retirementRevision(agent) === retirement
    const gone = new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    // Every stage settles as nothing the moment the refresh ends, whatever I/O is still running.
    const bounded = <T>(work: Promise<T | null>): Promise<T | null> =>
      Promise.race([
        work.then(
          (value) => (current() ? value : null),
          () => null
        ),
        gone
      ])
    const listing = Promise.withResolvers<void>()
    const defaults = Promise.withResolvers<void>()
    const targets = new Set<string>()
    const holders = new Set<AbortSignal>()
    let register: ((holder?: AbortSignal) => void) | undefined
    let demand: ((model: string) => void) | undefined
    let projecting: Promise<void> | undefined
    const run = async (): Promise<void> => {
      const facts = await bounded(resolveAgentModelCatalogAccount(deps, launch, current))
      if (!facts) {
        return
      }
      const { record, scoped, workspacePath, folder, base, probeHome } = facts
      const bound: AgentModelCatalogBinding = {
        identity: launch.identity,
        agent,
        legacy: launch.legacy,
        local: !record || record.location.executionHostId === 'local',
        workspaceId: record?.location.workspaceId,
        current: () => !lifetime.aborted && deps.store.retirementRevision(agent) === retirement,
        fingerprint: base,
        base,
        exact: false,
        folder,
        workspacePath,
        // A workspace that was named but cannot be inspected here may pick its own model.
        keepDefault: workspacePath === undefined || agentModelCatalogDefaultFollowsAccount(agent)
      }
      // Prewarm proves the selected account before command/folder resolution can finish.
      if (
        independentAgentModelCatalog(agent) &&
        !scoped &&
        workspacePath === undefined &&
        !launch.legacy &&
        !launch.passive
      ) {
        bindAgentModelCatalogScope(bindings, launch.bindingKey, bound, requestKey, true)
      }
      // The folder's own settings, read alongside discovery; they only ever describe this binding.
      bound.projecting = bounded(
        agentModelCatalogListedDefault(deps, agent, workspacePath, probeHome)
      ).then((keepDefault) => {
        if (keepDefault !== null) {
          bound.keepDefault = keepDefault
        }
        bound.projecting = undefined
      })
      projecting = bound.projecting
      void projecting.finally(defaults.resolve)
      const scope = await bounded(
        resolveAgentModelCatalogScope(
          deps,
          { agent, workspacePath, savedOnly: launch.passive, legacy: launch.legacy },
          scoped,
          base,
          probeHome,
          current,
          { current, signal }
        )
      )
      if (!scope) {
        return
      }
      const { fingerprint, exact, resolved, cwd } = scope
      Object.assign(bound, { fingerprint, exact, cwd })
      bindAgentModelCatalogScope(bindings, launch.bindingKey, bound, requestKey)
      const probe = deps.probes?.[agent]
      let completion: Promise<AgentModelCatalogEntry | null> | undefined
      if (
        !launch.passive &&
        (exact || !agentModelCatalogReleasedOwner(scoped)) &&
        probe &&
        probeHome
      ) {
        const lister = scopedAgentModelCatalogLister({
          legacy: launch.legacy,
          signal: lifetime,
          resolved,
          probe,
          probeHome,
          workspacePath: cwd ?? folder
        })
        const attach = (holder: AbortSignal) => {
          if (holder.aborted || !current()) {
            return
          }
          completion = deps.store.refresh(
            fingerprint,
            agent,
            (selected, owner, publish) => {
              const task = lister(selected, owner, publish)
              tasks.add(task)
              void task.finally(() => tasks.delete(task)).catch(() => {})
              return task
            },
            { signal: holder, lifetime, admission }
          )
        }
        register = (holder) => {
          if (!current()) {
            return
          }
          if (deps.store.isListing(fingerprint)) {
            if (holder) {
              attach(holder)
            } else {
              for (const live of holders) {
                attach(live)
              }
            }
          } else if (
            deps.store.probeDue(fingerprint) ||
            [...targets].some((model) => deps.store.efforts.due(fingerprint, model))
          ) {
            for (const live of holders) {
              attach(live)
            }
            for (const model of targets) {
              deps.store.efforts.demand(fingerprint, model)
            }
          }
        }
        demand = (model) => {
          if (!deps.store.isListing(fingerprint)) {
            register?.()
          } else {
            deps.store.efforts.demand(fingerprint, model)
          }
        }
        register()
      }
      listing.resolve()
      if (launch.passive) {
        await bound.projecting
      } else {
        // Readers can leave while current discovery continues.
        const seeded = Promise.resolve(completion).then((entry) => {
          if (entry !== null && bound.current()) {
            seedAccountList(deps, scope, agent)
          }
        })
        await bounded(seeded)
      }
    }
    const end = (): void => ended.abort()
    const held: Held = {
      current: () => current() && refreshes.get(key) === held,
      hold: (reader) => {
        if (reader.signal.aborted) {
          return
        }
        const released = new AbortController()
        const timer =
          reader.deadline === undefined
            ? undefined
            : setTimeout(() => released.abort(), Math.max(0, reader.deadline - Date.now()))
        const holder = AbortSignal.any([signal, reader.signal, released.signal])
        const leave = () => {
          clearTimeout(timer)
          holders.delete(holder)
        }
        holders.add(holder)
        holder.addEventListener('abort', leave, { once: true })
        register?.(holder)
      },
      listing: listing.promise,
      defaults: defaults.promise,
      done: Promise.resolve(),
      want: (model) => {
        if (model && !targets.has(model)) {
          targets.add(model)
          demand?.(model)
        }
      },
      workspaceId: launch.records.record?.location.workspaceId,
      end
    }
    refreshes.set(key, held)
    held.done = run()
      .catch(() => {})
      .finally(() => listing.resolve())
    // The folder's settings may still arrive after the listing ends.
    const settled = held.done
      .then(() => projecting)
      .finally(() => {
        ended.abort()
        defaults.resolve()
        if (refreshes.get(key) === held) {
          refreshes.delete(key)
        }
      })
    tasks.add(settled)
    void settled.finally(() => tasks.delete(settled))
    return held
  }
  return {
    /** Joins the running refresh for this request, or starts one; joining changes nothing. */
    join(key: string, launch: AgentModelCatalogLaunch): AgentModelCatalogRefresh {
      const running = refreshes.get(key)
      return running?.current() ? running : start(key, launch)
    },
    pending: (key: string): boolean => refreshes.get(key)?.current() === true,
    /** A workspace's folder or command context changed: its refreshes (all, without one) end. */
    retire(workspaceId?: string): void {
      for (const held of refreshes.values()) {
        if (workspaceId === undefined || held.workspaceId === workspaceId) {
          held.end()
        }
      }
    }
  }
}
