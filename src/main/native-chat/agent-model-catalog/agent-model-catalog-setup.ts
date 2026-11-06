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
}

type Held = AgentModelCatalogSetup & { fingerprint?: string; settled?: boolean }

const MAX_SETUP_MS = AGENT_MODEL_CATALOG_PICKER_WAIT_MS

/** Readers of the same request share one setup (account, folder, CLI and scope resolution, and
 *  the folder's own default settings). It belongs to no reader: its budget is fixed when it starts
 *  (the starting reader's deadline, which later readers never extend) and it also ends with the
 *  service or the agent's retirement, so a reader leaving or its chat closing never ends it for
 *  another. Readers each check their own operation before using it. It is reused while it runs and
 *  while the listing it found is still running, then dropped, so nothing is cached past that. */
export function createAgentModelCatalogSetups(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortSignal
) {
  const setups = new Map<string, Held>()
  const reusable = (held: Held | undefined): held is Held =>
    !!held &&
    !held.lapsed() &&
    (!held.settled || (held.fingerprint !== undefined && deps.store.isListing(held.fingerprint)))
  return (
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
    const expired = new AbortController()
    const timer = setTimeout(() => expired.abort(), Math.max(0, deadline - Date.now()))
    timer.unref?.()
    const current = (): boolean =>
      !lifetime.aborted &&
      !expired.signal.aborted &&
      deps.store.retirementRevision(params.agent) === retirement
    const operation = { deadline, current, signal: AbortSignal.any([lifetime, expired.signal]) }
    const account = resolveAccount(deps, params, current)
    const scope = account.then((facts) =>
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
    const defaults = account.then((facts) =>
      facts && current()
        ? agentModelCatalogListedDefaults(deps, params.agent, facts.workspacePath, facts.probeHome)
        : null
    )
    const held: Held = { lapsed: () => expired.signal.aborted, account, scope, defaults }
    setups.set(key, held)
    void scope.then((facts) => {
      clearTimeout(timer)
      held.settled = true
      held.fingerprint = current() ? facts?.fingerprint : undefined
      const drop = (): void => {
        if (setups.get(key) === held) {
          setups.delete(key)
        }
      }
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
