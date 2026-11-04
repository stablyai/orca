import { resolveWorkerLineageFacts } from '../db/dispatch-context/worker-follow-up-plan'
import {
  createWorkerFollowUpQualification,
  planSemanticWorkerFollowUp,
  workerFollowUpArguments
} from '../../rpc/methods/orchestration/worker/worker-follow-up-admission'
import type { createCrewFollowUpAuthorityInputs } from './crew-follow-up-authority-inputs'
import type { DispatchCreator } from '../db/dispatch-depth'
import {
  prepareCrewDispatchRecipients,
  crewDispatchRecipientAvailable
} from './crew-recipient-dispatches'
import type {
  crewRecipientOwnerQueries,
  CrewRecipientRun,
  DispatchInput
} from './crew-recipient-owner-queries'
import type { createLineageRunningSessionResolver } from '../structured-session-lineage'
import type { selectBareRecipientOwner } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import type { CrewRecipientKey as Key } from './crew-recipient-worker-facts'
import type { CrewRecipientTerminal, Recipient } from './crew-recipient-inputs'

type MailboxSelectionInputs = {
  query: ReturnType<typeof crewRecipientOwnerQueries>
  running: ReturnType<typeof createLineageRunningSessionResolver>
  listedSessions: () => ReadonlySet<string>
  currentRuns: (keys: Key[]) => void
  currentRun: (key: Key) => CrewRecipientRun | undefined
  keyForInput: (id: Recipient) => Key | undefined
  resolve: (
    id: Recipient,
    senderRunId?: string
  ) => ReturnType<typeof selectBareRecipientOwner> | undefined
  candidates: (key: Key, caller?: boolean) => DispatchInput[]
  covered: ReadonlySet<string>
  sourceKey: (key: Key) => string
  explicitDispatches: Map<string, DispatchInput | null>
  namedRuns: Map<string, CrewRecipientRun | null>
  followUpNodes: Map<
    string,
    ReturnType<ReturnType<typeof crewRecipientOwnerQueries>['followUps']>[number] | null
  >
  prepareFollowUps: (selected: DispatchInput[]) => void
  boundRuns: (key: Key) => CrewRecipientRun[]
  authorityInputs: ReturnType<typeof createCrewFollowUpAuthorityInputs>
}

export function createCrewRecipientMailboxSelection({
  query,
  running,
  listedSessions,
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
  authorityInputs
}: MailboxSelectionInputs) {
  const followUpNode = (id: string) => {
    if (!followUpNodes.has(id)) {
      throw new Error('Crew follow-up inputs are incomplete')
    }
    return followUpNodes.get(id) ?? undefined
  }
  const followUpPlan = (row: DispatchInput) =>
    followUpNodes.has(row.id)
      ? planSemanticWorkerFollowUp(
          row.id,
          row,
          () =>
            resolveWorkerLineageFacts(
              {
                dispatch: followUpNode,
                ownedResource: (id) => {
                  const resource = followUpNode(id)?.lineage_resource
                  return resource?.owner_dispatch_id === id ? resource : undefined
                },
                formerResource: (id) => followUpNode(id)?.lineage_resource ?? undefined,
                followUp: (id) => {
                  const next = followUpNode(id)?.next_dispatch_id
                  return next ? followUpNode(next) : undefined
                }
              },
              row.id
            ),
          'status',
          (id) => followUpNode(id)?.protocol_version != null,
          (id) => Boolean(followUpNode(id)?.has_worker)
        )
      : undefined
  const effective = (row: DispatchInput) => {
    const plan = followUpPlan(row)
    return plan?.kind === 'steer' ? followUpNode(plan.dispatchId) : row
  }
  const prepareNested = (selected: Iterable<DispatchInput>, terminal: CrewRecipientTerminal) =>
    prepareCrewDispatchRecipients(selected, terminal, running, listedSessions, currentRuns)
  const finish = (
    ids: Recipient[],
    senderRunId: string | undefined,
    terminal: CrewRecipientTerminal
  ) => {
    const selections = new Map(ids.map((id) => [id, resolve(id, senderRunId)]))
    const selected = new Map<string, DispatchInput>()
    for (const [id, resolution] of selections) {
      const key = keyForInput(id)
      if (key && resolution?.ok && resolution.to.startsWith('dispatch:')) {
        const candidate = candidates(key).find((row) => `dispatch:${row.id}` === resolution.to)
        if (candidate) {
          selected.set(candidate.id, candidate)
        }
      }
    }
    const nested = prepareNested(selected.values(), terminal)
    return (id: Recipient): boolean | undefined => {
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
      const key = nested.get(row.id)
      return crewDispatchRecipientAvailable(row, key ? currentRun(key) : undefined)
    }
  }
  const prepareExplicit = (addresses: string[], terminal: CrewRecipientTerminal) => {
    const ids = [
      ...new Set(
        addresses
          .filter((address) => address.startsWith('dispatch:'))
          .map((address) => address.slice(9))
      )
    ].filter((id) => !explicitDispatches.has(id))
    const rows = ids.length
      ? query.dispatches(
          ids.map((id) => ({
            key: id,
            id,
            handle: '',
            caller: false,
            pane: null,
            suffix: null
          }))
        )
      : []
    const runIds = [
      ...new Set(
        addresses.filter((address) => address.startsWith('run:')).map((address) => address.slice(4))
      )
    ].filter((id) => !namedRuns.has(id))
    const runRows = runIds.length
      ? query.currentRuns(
          runIds.map((id) => ({
            key: id,
            id,
            session: null,
            suffix: null
          }))
        )
      : []
    const acquired = new Map(rows.map((row) => [row.id, row]))
    const selected = addresses.flatMap((address) => {
      if (!address.startsWith('dispatch:')) {
        return []
      }
      const id = address.slice(9)
      const row = acquired.get(id) ?? explicitDispatches.get(id)
      return row ? [row] : []
    })
    prepareFollowUps(selected)
    const targets = selected.flatMap((row) => {
      const target = effective(row)
      return target ? [target] : []
    })
    const nested = prepareNested(new Map(targets.map((row) => [row.id, row])).values(), terminal)
    const runsById = new Map(runRows.map((row) => [row.id, row]))
    const dispatchesById = new Map(rows.map((row) => [row.id, row]))
    for (const id of runIds) {
      namedRuns.set(id, runsById.get(id) ?? null)
    }
    for (const id of ids) {
      explicitDispatches.set(id, dispatchesById.get(id) ?? null)
    }
    return nested
  }
  const qualification = (caller: Key, projection: () => DispatchCreator, maxDepth: () => number) =>
    createWorkerFollowUpQualification<
      { id: string; legacy: number },
      NonNullable<ReturnType<typeof authorityInputs.dispatch>>
    >({
      ...authorityInputs,
      coordinated: () => currentRun(caller),
      named: (id) => boundRuns(caller).find((run) => run.id === id),
      run: (id) => {
        const coveredRun = namedRuns.get(id) ?? [...boundRuns(caller)].find((run) => run.id === id)
        return coveredRun ?? authorityInputs.run(id)
      },
      caller: () => authorityInputs.caller(projection()),
      maxDepth
    })
  const explicit = (
    address: string,
    caller: Key,
    nested: ReadonlyMap<string, Key>,
    qualify: ReturnType<typeof qualification>
  ): boolean => {
    if (!covered.has(sourceKey(caller))) {
      throw new Error('Crew caller inputs are incomplete')
    }
    const dispatch = address.startsWith('dispatch:')
      ? explicitDispatches.get(address.slice(9))
      : undefined
    const namedId = address.startsWith('run:') ? address.slice(4) : undefined
    if (
      (address.startsWith('dispatch:') && dispatch === undefined) ||
      (namedId && !namedRuns.has(namedId))
    ) {
      throw new Error('Crew explicit recipient inputs are incomplete')
    }
    if (namedId) {
      const run = namedRuns.get(namedId)
      return Boolean(
        run &&
        run.legacy !== 1 &&
        run.id === namedId &&
        run.home_database !== 'remote' &&
        (!candidates(caller, true)[0] || candidates(caller, true)[0].run_id === run.id)
      )
    }
    if (
      !dispatch ||
      dispatch.sender_run_id !== dispatch.run_id ||
      dispatch.sender_run_legacy === 1
    ) {
      return false
    }
    const plan = followUpPlan(dispatch)
    if (plan?.kind === 'start') {
      return qualify(plan.latest.run_id, workerFollowUpArguments(plan)).kind === 'admitted'
    }
    const target = effective(dispatch)
    if (!target) {
      return false
    }
    const key = nested.get(target.id)
    return crewDispatchRecipientAvailable(target, key ? currentRun(key) : undefined)
  }
  return { finish, prepareExplicit, explicit, qualification }
}
