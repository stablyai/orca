import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  runCoordinatorKey,
  runBoundToCoordinator
} from '../../addressing/orchestration-caller-identity'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../shared/orchestration-party-identity'
import { isEquivalentPaneKey } from '../../db/pane-key-match'

/** Capture only the actor whose exact binding was validated for this answer. */
export function acceptedAnswerSender(
  runtime: OrcaRuntimeService,
  role: string,
  caller?: OrchestrationCallerIdentity
): () => string | undefined {
  const db = runtime.getOrchestrationDb()
  const binding = () => {
    try {
      if (role.startsWith('run:')) {
        const run = db.getRun(role.slice(4))
        return run
          ? {
              ...runCoordinatorKey(run),
              generation: run.consumer_generation,
              incarnation: run.coordinator_handle
                ? runtime.getTerminalProcessIncarnation(run.coordinator_handle)
                : null
            }
          : null
      }
      const dispatch = db.getDispatchContextById(role.slice(9))
      return dispatch
        ? {
            terminalHandle: dispatch.assignee_handle,
            orcaSessionId: dispatch.assignee_orca_session_id,
            paneKey: dispatch.assignee_pane_key,
            generation: dispatch.consumer_generation,
            hostScope: dispatch.host_scope,
            incarnation: dispatch.process_incarnation
          }
        : null
    } catch {
      return null
    }
  }
  const actorObservation = () =>
    caller?.terminalHandle
      ? {
          paneKey: runtime.getTerminalPaneKey(caller.terminalHandle),
          incarnation: runtime.getTerminalProcessIncarnation(caller.terminalHandle)
        }
      : null
  const expected = JSON.stringify(binding())
  let observed: string | undefined
  try {
    observed = JSON.stringify(actorObservation())
  } catch {
    /* Optional observation. */
  }
  return () => {
    try {
      const current = binding()
      if (!current || JSON.stringify(current) !== expected) {
        return
      }
      if (caller) {
        if (JSON.stringify(actorObservation()) !== observed) {
          return
        }
        if (
          caller.terminalHandle &&
          caller.paneKey &&
          !isEquivalentPaneKey(
            caller.paneKey,
            runtime.getTerminalPaneKey(caller.terminalHandle) ?? ''
          )
        ) {
          return
        }
        if (role.startsWith('run:')) {
          const run = db.getRun(role.slice(4))
          if (!run || !runBoundToCoordinator(run, caller)) {
            return
          }
        } else if (
          db.getActiveDispatchForIdentity(caller.address, caller.paneKey ?? undefined)?.id !==
          role.slice(9)
        ) {
          return
        }
      }
      const actor = caller ?? current
      const party = {
        address: role,
        terminalHandle: actor.terminalHandle,
        orcaSessionId: actor.orcaSessionId
      }
      const snapshot = runtime.orchestrationSenderNames.snapshotOf(
        caller ? { ...party, address: caller.address } : party
      )
      return JSON.stringify({
        version: 1,
        sender: {
          party: { ...party, terminalHandle: null },
          name: snapshot.name,
          ...(snapshot.agent ? { agent: snapshot.agent } : {})
        }
      })
    } catch {
      return undefined
    }
  }
}
