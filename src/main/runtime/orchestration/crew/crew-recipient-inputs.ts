import { createCrewFollowUpAuthorityInputs } from './crew-follow-up-authority-inputs'
import { createCrewRecipientFollowUpInputs } from './crew-recipient-follow-up-inputs'
import {
  crewRecipientOwnerQueries,
  type CrewRecipientRun,
  type DispatchInput
} from './crew-recipient-owner-queries'
import type { OrcaSessionId } from '../../../../shared/orca-session-address'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { OrchestrationDb } from '../db'
import {
  createLineageRunningSessionResolver,
  type AgentSessionRecordReader
} from '../structured-session-lineage'
import { runBoundToCoordinator } from '../orchestration-caller-identity'
import { paneKeyMatchSuffix } from '../db/pane-key-match'
import {
  activeDispatchMailboxBranch,
  equivalentDispatchMailboxOwners
} from '../db/dispatch-mailbox-selection'
import { selectBareRecipientOwner } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { deriveStructuredSessionMailReach } from '../structured-session-mail-address'

import { createCrewRecipientMailboxSelection } from './crew-recipient-mailbox-selection'
import {
  createCrewRecipientWorkerFacts,
  type CrewRecipientKey as Key
} from './crew-recipient-worker-facts'
export type Recipient = OrcaSessionId | Key
export type CrewRecipientTerminal = {
  livePane: (handle: string) => string | null
  process: (handle: string) => string | null
}
const sourceKey = (key: Key) => key.sourceKey ?? key.address

/** Complete keyed facts live only in the disposable host generation; decisions remain request-local. */
export function createCrewRecipientInputs(
  db: OrchestrationDb,
  records: AgentSessionRecordReader | null,
  canonical: (id: OrcaSessionId) => OrcaSessionId,
  legacyOwner: () => ReturnType<OrchestrationDb['getLegacyAdoptedRunMailboxOwner']>
) {
  const query = crewRecipientOwnerQueries(db)
  const running = createLineageRunningSessionResolver(records)
  const runs = new Map<string, CrewRecipientRun[]>()
  const dispatches = new Map<string, DispatchInput[]>()
  const owners = new Map<string, string[]>()
  const covered = new Set<string>()
  let visible:
    | ReturnType<NonNullable<AgentSessionRecordReader['getVisibleSessionTabIndex']>>
    | undefined
  let listed: ReadonlySet<string> = new Set()
  let visibilityRead = false
  const visibility = () => {
    if (!visibilityRead) {
      visible = records?.getVisibleSessionTabIndex?.()
      listed = new Set(visible?.sessionIds ?? [])
      visibilityRead = true
    }
    return visible
  }
  const {
    keyFor,
    prepare: prepareIdentities,
    covered: identityCovered,
    livePane
  } = createCrewRecipientWorkerFacts(query, running, canonical, () => {
    visibility()
    return listed
  })
  const currentRuns = (selected: Key[]) => {
    const missing = selected.filter((key) => !runs.has(sourceKey(key)))
    if (!missing.length) {
      return
    }
    const requested = missing.map((key) => ({
      key: sourceKey(key),
      session: key.orcaSessionId,
      suffix: key.paneKey === null ? null : paneKeyMatchSuffix(key.paneKey)
    }))
    const rows = query.currentRuns(requested)
    for (const key of missing) {
      runs.set(sourceKey(key), [])
    }
    for (const row of rows) {
      runs.get(row.key)!.push(row)
    }
  }
  const boundRuns = (key: Key) =>
    runs.get(sourceKey(key))?.filter((run) => runBoundToCoordinator(run, key)) ?? []
  const currentRun = (key: Key) => boundRuns(key)[0]
  const keyForInput = (input: Recipient) =>
    typeof input === 'string'
      ? keyFor(input)
      : input.orcaSessionId
        ? keyFor(input.orcaSessionId)
        : input
  const paneFor = (key: Key) => (key.orcaSessionId ? livePane(key) : (key.paneKey ?? undefined))
  const prepare = (ids: Recipient[], viewer?: Key) => {
    const sessions = ids.flatMap((input) =>
      typeof input === 'string' ? [input] : input.orcaSessionId ? [input.orcaSessionId] : []
    )
    prepareIdentities(viewer?.orcaSessionId ? [...sessions, viewer.orcaSessionId] : sessions)
    const actual = viewer?.orcaSessionId ? keyFor(viewer.orcaSessionId) : viewer
    const caller = actual
      ? {
          ...actual,
          sourceKey: JSON.stringify([
            'caller',
            actual.address,
            actual.paneKey,
            actual.orcaSessionId
          ])
        }
      : undefined
    const selected = ids.flatMap((id) => {
      const key = keyForInput(id)
      return key && !covered.has(sourceKey(key)) ? [key] : []
    })
    if (caller && !covered.has(sourceKey(caller))) {
      selected.push(caller)
    }
    const unique = [...new Map(selected.map((key) => [sourceKey(key), key])).values()]
    if (!unique.length) {
      return caller
    }
    currentRuns(unique)
    const request = unique.map((key) => {
      const pane = key === caller ? (key.paneKey ?? undefined) : paneFor(key)
      return {
        key: sourceKey(key),
        handle: key.address,
        caller: key === caller,
        pane: pane ?? null,
        suffix: pane && parsePaneKey(pane) ? paneKeyMatchSuffix(pane) : null
      }
    })
    const rows = query.dispatches(request)
    for (const key of unique) {
      dispatches.set(sourceKey(key), [])
      owners.set(sourceKey(key), [])
    }
    for (const row of rows) {
      dispatches.get(row.key)!.push(row)
    }
    const history = query.history(
      unique
        .filter((key) => key !== caller)
        .map((key) => ({ key: sourceKey(key), handle: key.address }))
    )
    for (const row of history) {
      owners.get(row.key)!.push(row.run_id)
    }
    for (const key of unique) {
      covered.add(sourceKey(key))
    }
    return caller
  }
  const candidates = (key: Key, caller = false) => {
    const rows = dispatches.get(sourceKey(key))!
    const handle = rows.filter((row) => row.branch === 'handle')
    const pane = caller ? (key.paneKey ?? undefined) : paneFor(key)
    const exact = rows.filter((row) => row.branch === 'pane')
    const branch = activeDispatchMailboxBranch(handle, pane, exact)
    const suffix = rows.filter((row) => row.branch === 'suffix')
    return branch === 'handle'
      ? handle
      : branch === 'pane'
        ? exact
        : caller
          ? suffix
          : equivalentDispatchMailboxOwners(suffix, pane!)
  }
  const senderRun = (caller: Key | undefined) => {
    if (!caller || !covered.has(sourceKey(caller))) {
      return { kind: 'unknown' } as const
    }
    const dispatch = candidates(caller, true)[0]
    const run = dispatch?.sender_run_id
      ? { id: dispatch.sender_run_id, legacy: dispatch.sender_run_legacy }
      : currentRun(caller)
    if (dispatch && (!run || ('legacy' in run && run.legacy === 1) || dispatch.run_id !== run.id)) {
      return { kind: 'refused' } as const
    }
    return { kind: 'ready', id: run?.id } as const
  }
  const fallback = (id: OrcaSessionId): boolean | undefined => {
    if (!records) {
      return undefined
    }
    if (!records.getRecord(id)) {
      return false
    }
    return (
      deriveStructuredSessionMailReach(
        running(id),
        (liveId) => keyFor(liveId) !== undefined,
        () => {
          const visible = visibility()
          return visible
            ? { present: visible.present, isListed: (id: string) => listed.has(id) }
            : undefined
        }
      ).kind === 'reachable'
    )
  }
  const resolve = (id: Recipient, senderRunId?: string) => {
    const key = keyForInput(id)
    if (!key || !covered.has(sourceKey(key))) {
      return undefined
    }
    return selectBareRecipientOwner({
      handle: key.address,
      senderRunId,
      boundRuns: () => boundRuns(key),
      dispatches: () => candidates(key),
      ownerRunIds: () => {
        const ids = new Set(owners.get(sourceKey(key))!)
        const adopted = legacyOwner()
        if (adopted?.terminalHandle === key.address) {
          ids.add(adopted.runId)
        }
        return [...ids].sort()
      },
      fallback: () => {
        const reachable = key.orcaSessionId ? fallback(key.orcaSessionId) : Boolean(key.paneKey)
        if (reachable === undefined) {
          throw new Error('Crew recipient source is unavailable')
        }
        return reachable
          ? { ok: true, to: key.address, runId: senderRunId }
          : {
              ok: false,
              code: 'terminal_not_found',
              message: '',
              warning: { code: 'recipient_unreachable', recipient: key.address, message: '' }
            }
      }
    })
  }
  const explicitDispatches = new Map<string, DispatchInput | null>()
  const namedRuns = new Map<string, CrewRecipientRun | null>()
  const { followUpNodes, prepareFollowUps } = createCrewRecipientFollowUpInputs(query)

  const { finish, prepareExplicit, explicit, qualification } = createCrewRecipientMailboxSelection({
    query,
    running,
    listedSessions: () => {
      visibility()
      return listed
    },
    currentRuns,
    currentRun,
    keyForInput,
    resolve,
    candidates,
    covered,
    sourceKey,
    explicitDispatches,
    namedRuns,
    followUpNodes,
    prepareFollowUps,
    boundRuns,
    authorityInputs: createCrewFollowUpAuthorityInputs(db)
  })
  return {
    prepare,
    prepareExplicit,
    explicit,
    qualification,
    explicitDispatch: (id: string) => explicitDispatches.get(id),
    keyFor,
    identityCovered,
    currentRun,
    candidates,
    covered,
    finish,
    senderRun
  }
}
