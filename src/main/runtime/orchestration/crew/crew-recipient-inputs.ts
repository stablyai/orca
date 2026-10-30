import {
  crewRecipientOwnerQueries,
  type CrewRecipientRun,
  type DispatchInput
} from './crew-recipient-owner-queries'
import type { OrcaSessionId } from '../../../../shared/orca-session-address'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { OrchestrationDb } from '../db'
import {
  structuredWorkerIdentities,
  structuredWorkerIdentityFromRow
} from '../../structured-worker-identity'
import { structuredWorkerRecordIsCurrent } from '../../structured-worker-identity'
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
import {
  dispatchAssigneeCoordinatorKey,
  selectRunBoundDispatchRecipient,
  selectBareRecipientOwner
} from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { federatedControlMailRefusal } from '../../rpc/methods/orchestration/messaging/send-control-mail'
import { deriveStructuredSessionMailReach } from '../structured-session-mail-address'
import { isStructuredWorkerHandle } from '../../../../shared/structured-worker-handle'

import {
  createCrewRecipientWorkerFacts,
  type CrewRecipientKey as Key
} from './crew-recipient-worker-facts'
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
  const currentRun = (key: Key) =>
    runs.get(sourceKey(key))?.find((run) => runBoundToCoordinator(run, key))
  const prepare = (ids: OrcaSessionId[], viewer?: Key) => {
    prepareIdentities(viewer?.orcaSessionId ? [...ids, viewer.orcaSessionId] : ids)
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
      const key = keyFor(id)
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
      const pane = key === caller ? (key.paneKey ?? undefined) : livePane(key)
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
      covered.add(sourceKey(key))
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
    const adopted = legacyOwner()
    if (adopted && unique.some((key) => key !== caller && key.address === adopted.terminalHandle)) {
      owners.get(adopted.terminalHandle)!.push(adopted.runId)
    }
    return caller
  }
  const candidates = (key: Key, caller = false) => {
    const rows = dispatches.get(sourceKey(key))!
    const handle = rows.filter((row) => row.branch === 'handle')
    const pane = caller ? (key.paneKey ?? undefined) : livePane(key)
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
  const resolve = (id: OrcaSessionId, senderRunId?: string) => {
    const key = keyFor(id)
    if (!key || !covered.has(sourceKey(key))) {
      return undefined
    }
    return selectBareRecipientOwner({
      handle: key.address,
      senderRunId,
      boundRun: () => currentRun(key),
      dispatches: () => candidates(key),
      ownerRunIds: () => [...new Set(owners.get(sourceKey(key))!)].sort(),
      fallback: () =>
        fallback(id) === true
          ? { ok: true, to: key.address, runId: senderRunId }
          : {
              ok: false,
              code: 'terminal_not_found',
              message: '',
              warning: { code: 'recipient_unreachable', recipient: key.address, message: '' }
            }
    })
  }
  const finish = (
    ids: OrcaSessionId[],
    senderRunId: string | undefined,
    terminal: {
      livePane: (handle: string) => string | null
      process: (handle: string) => string | null
    }
  ) => {
    const selections = new Map(ids.map((id) => [id, resolve(id, senderRunId)]))
    const selected = new Map<string, DispatchInput>()
    for (const [id, resolution] of selections) {
      const key = keyFor(id)
      if (key && resolution?.ok && resolution.to.startsWith('dispatch:')) {
        const candidate = candidates(key).find((row) => `dispatch:${row.id}` === resolution.to)
        if (candidate) {
          selected.set(candidate.id, candidate)
        }
      }
    }
    const nested = new Map<string, Key>()
    for (const row of selected.values()) {
      const key = dispatchAssigneeCoordinatorKey(
        row,
        () => row.protocol_version !== null,
        (handle) => {
          if (!isStructuredWorkerHandle(handle)) {
            return terminal.livePane(handle)
          }
          const identity =
            structuredWorkerIdentities.get(handle) ??
            (row.nested_resource ? structuredWorkerIdentityFromRow(row.nested_resource) : null)
          const live = identity ? running(identity.sessionId) : null
          return live?.kind === 'here' &&
            structuredWorkerRecordIsCurrent(
              live.record,
              live.record.ownerObservation.claimStatus === 'released' && listed.has(live.sessionId)
            ) &&
            row.nested_resource?.release_state !== 'released'
            ? (identity?.paneKey ?? null)
            : null
        },
        terminal.process
      )
      if (key) {
        nested.set(row.id, { ...key, address: `nested:${row.id}` })
      }
    }
    currentRuns([...nested.values()])
    return (id: OrcaSessionId): boolean | undefined => {
      const resolution = selections.get(id)
      if (!resolution?.ok) {
        return resolution ? false : undefined
      }
      if (!resolution.to.startsWith('dispatch:')) {
        return true
      }
      const row = selected.get(resolution.to.slice('dispatch:'.length))
      if (!row) {
        return undefined
      }
      if (row.protocol_version !== null) {
        return !federatedControlMailRefusal(
          row.id,
          row.protocol_version,
          () => row.worker_state ?? undefined
        )
      }
      const key = nested.get(row.id)
      const redirected = selectRunBoundDispatchRecipient(row, key ? currentRun(key) : undefined)
      return Boolean(redirected || row.status === 'pending' || row.status === 'dispatched')
    }
  }
  return {
    prepare,
    keyFor,
    currentRun,
    candidates,
    covered,
    finish,
    senderRun
  }
}
