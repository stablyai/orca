import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogReadRecords } from './agent-model-catalog-read-scope'
import { recordCatalogKey } from './agent-model-catalog-fingerprint'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import {
  agentModelCatalogListedDefaults,
  catalogFolder,
  sessionWorkspacePath,
  type AgentModelCatalogListedDefaults
} from './agent-model-catalog-workspace'
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from './agent-model-catalog-listing-waiters'
import { seedAccountList } from './agent-model-catalog-account-list'

type Records = NonNullable<ReturnType<typeof agentModelCatalogReadRecords>>

/** What a read's account resolves to, fixed when its setup started. */
export type AgentModelCatalogAccountFacts = {
  record: Records['record']
  scoped: Records['scoped']
  savedOnly: boolean
  workspacePath: string | null | undefined
  folder: string | undefined
  base: string
  probeHome: AgentSessionAccountHome | null
}

export type AgentModelCatalogScopeFacts = NonNullable<
  Awaited<ReturnType<typeof resolveAgentModelCatalogScope>>
>

export type AgentModelCatalogSetup = {
  /** Whether it ran out of its own budget (a later reader starts a fresh one). */
  lapsed: () => boolean
  account: Promise<AgentModelCatalogAccountFacts | null>
  scope: Promise<AgentModelCatalogScopeFacts | null>
  defaults: Promise<AgentModelCatalogListedDefaults | null>
  /** Seeds the account's own list from this scope's listing, once per setup, not per reader. */
  seed: (agent: string, facts: AgentModelCatalogScopeFacts) => void
}

type Held = AgentModelCatalogSetup & {
  fingerprint?: string
  settled?: boolean
  workspaceId?: string
  end: () => void
}

const MAX_SETUP_MS = AGENT_MODEL_CATALOG_PICKER_WAIT_MS

/** Readers of the same request share one setup (account, folder, CLI and scope resolution, and
 *  the folder's own default settings). It belongs to no reader: its budget is fixed when it starts
 *  (the starting reader's deadline, which later readers never extend) and it also ends with the
 *  service, the agent's retirement or its workspace's, so a reader leaving or its chat closing
 *  never ends it for another. When it ends its answers settle as nothing at once, whatever I/O is
 *  still running, and a reader with time left starts a fresh one. Readers each check their own
 *  operation before using it. It is reused while it runs and while the listing it found is still
 *  running, then dropped, so nothing is cached past that. */
export function createAgentModelCatalogSetups(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortSignal
) {
  const setups = new Map<string, Held>()
  const reusable = (held: Held | undefined): held is Held =>
    !!held &&
    !held.lapsed() &&
    (!held.settled || (held.fingerprint !== undefined && deps.store.isListing(held.fingerprint)))
  const share = (
    key: string,
    params: AgentModelCatalogReadParams,
    readerDeadline: number
  ): AgentModelCatalogSetup => {
    const existing = setups.get(key)
    if (reusable(existing)) {
      return existing
    }
    const retirement = deps.store.retirementRevision(params.agent)
    const deadline = Math.min(readerDeadline, Date.now() + MAX_SETUP_MS)
    const ended = new AbortController()
    const signal = AbortSignal.any([lifetime, ended.signal])
    const current = (): boolean =>
      !signal.aborted &&
      Date.now() < deadline &&
      deps.store.retirementRevision(params.agent) === retirement
    const drop = (): void => {
      if (setups.get(key) === held) {
        setups.delete(key)
      }
    }
    const end = (): void => {
      ended.abort()
      drop()
    }
    const timer = setTimeout(end, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    const gone = new Promise<null>((resolve) => {
      if (signal.aborted) {
        resolve(null)
      }
      signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    const bounded = <T>(work: Promise<T | null>): Promise<T | null> =>
      Promise.race([work.then((value) => (current() ? value : null)), gone])
    const operation = { deadline, current, signal }
    const account = bounded(resolveAccount(deps, params, current))
    const scope = bounded(
      account.then((facts) =>
        facts && current()
          ? resolveAgentModelCatalogScope(
              deps,
              { ...params, workspacePath: facts.workspacePath, savedOnly: facts.savedOnly },
              facts.scoped,
              facts.base,
              facts.probeHome,
              current,
              operation
            ).catch(() => null)
          : null
      )
    )
    const defaults = bounded(
      account.then((facts) =>
        facts && current()
          ? agentModelCatalogListedDefaults(
              deps,
              params.agent,
              facts.workspacePath,
              facts.probeHome
            )
          : null
      )
    )
    let seeded = false
    const held: Held = {
      seed: (agent, facts) => {
        if (!seeded) {
          seeded = true
          seedAccountList(deps, facts, agent)
        }
      },
      // Once settled its facts hold for the listing it found, past its budget, until ended.
      lapsed: () =>
        held.settled
          ? signal.aborted || deps.store.retirementRevision(params.agent) !== retirement
          : !current(),
      end,
      account,
      scope,
      defaults,
      workspaceId: agentModelCatalogReadRecords(deps, params)?.record?.location.workspaceId
    }
    setups.set(key, held)
    // Its budget holds until every stage has answered, the folder's default settings included.
    void Promise.all([scope, defaults]).finally(() => clearTimeout(timer))
    void scope.then((facts) => {
      held.settled = true
      held.fingerprint = current() ? facts?.fingerprint : undefined
      // Its readers start the listing it found as soon as it settles; it stays shared while that
      // listing runs and is dropped when it ends.
      setTimeout(() => {
        const running = held.fingerprint
          ? deps.store.pendingListing(held.fingerprint, true, true)
          : undefined
        if (running) {
          void running.finally(drop)
        } else {
          drop()
        }
      }, 0)
    })
    return held
  }
  return Object.assign(share, {
    /** A workspace's folder or command context changed: its setups (all, without one) end. */
    retire(workspaceId?: string): void {
      for (const held of setups.values()) {
        if (workspaceId === undefined || held.workspaceId === workspaceId) {
          held.end()
        }
      }
    }
  })
}

async function resolveAccount(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  current: () => boolean
): Promise<AgentModelCatalogAccountFacts | null> {
  const records = agentModelCatalogReadRecords(deps, params)
  if (!records) {
    return null
  }
  const { record, scoped } = records
  const savedOnly = !!params.savedOnly || records.savedOnly
  const workspacePath =
    params.inSessionWorkspace ||
    (record &&
      params.workspacePath === undefined &&
      !params.legacy &&
      (independentAgentModelCatalog(params.agent) ||
        deps.agentReadsProjectModelConfig?.(params.agent) === true))
      ? record
        ? await sessionWorkspacePath(deps, record)
        : null
      : params.workspacePath
  if (!current()) {
    return null
  }
  const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
  if (!current()) {
    return null
  }
  const account = scoped
    ? recordCatalogKey(scoped, folder)
    : await newChatCatalogKey(deps, params.agent, folder)
  if (!current() || !account) {
    return null
  }
  return {
    record,
    scoped,
    savedOnly,
    workspacePath,
    folder,
    base: account.fingerprint,
    probeHome: account.accountHome
  }
}
