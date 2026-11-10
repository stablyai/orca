import type {
  OrchestrationCallerShowResult,
  OrchestrationPartyLocationResult,
  OrchestrationSessionAddressResult
} from '../../../../../shared/orchestration/orchestration-caller-status'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../shared/orchestration/orchestration-session-caller-codes'
import {
  PartyLocationParams,
  SessionAddressParams
} from '../../../../../shared/rpc-contract/orchestration-params'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { resolveOrcaSessionParty } from '../../../orchestration/addressing/orchestration-party'
import { locateOrchestrationParty } from '../../../orchestration/addressing/orchestration-party-location'
import { readAgentSessionRecordStore } from '../../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { z } from 'zod'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RpcContext } from '../../core'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { openClosedWorkerTerminal } from './worker/closed-worker-terminal'
import { ensureStructuredHostInstalled } from '../structured-sessions/creation/structured-agent-session-gate'

async function locateParty(
  params: z.infer<typeof PartyLocationParams>,
  ctx: RpcContext
): Promise<OrchestrationPartyLocationResult> {
  let records: ReturnType<typeof readAgentSessionRecordStore> = null
  try {
    await ensureStructuredHostInstalled(ctx)
    records = readAgentSessionRecordStore()
  } catch {
    // Terminal routing remains usable when chat records cannot be installed.
  }
  const { runtime } = ctx
  return locateOrchestrationParty(
    params.address,
    {
      db: runtime.getOrchestrationDb(),
      records,
      terminalPaneKey: (handle) => runtime.getTerminalPaneKey(handle),
      terminalHandleForPaneKey: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey)
    },
    params.messageIds
  )
}

/** The terminal worker a lookup answered with, or proved lost. */
function closedWorkerHandle(
  address: string,
  located: OrchestrationPartyLocationResult,
  db: OrchestrationDb
): string | null {
  if (located.location?.kind === 'terminal') {
    return located.location.handle
  }
  if (located.lost !== 'terminal') {
    return null
  }
  return address.startsWith('dispatch:')
    ? (db.getDispatchContextById(address.slice('dispatch:'.length))?.assignee_handle ?? null)
    : address
}

export const ORCHESTRATION_CALLER_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.callerShow',
    access: { kind: 'reads', targets: {} },
    permission: 'workspace',
    params: null,
    // Dispatch already admitted the environment's session; do not resolve another caller from params.
    handler: (
      _params,
      { orchestrationCaller, orchestrationCompatibilityEvidence, runtime }
    ): OrchestrationCallerShowResult => ({
      caller: orchestrationCaller
        ? { orcaSessionId: formatOrcaSessionAddress(orchestrationCaller.orcaSessionId), live: true }
        : null,
      // An Orca-launched agent's own pane and launch secret prove it is one; no hook needs to have fired.
      terminal:
        !orchestrationCaller &&
        runtime.verifyOrchestrationCompatibilityCaller(orchestrationCompatibilityEvidence, {
          currentRuntimeLaunchSufficient: true
        }) !== null
    })
  }),
  defineOrchestrationMethod({
    name: 'orchestration.sessionAddress',
    access: { kind: 'reads', targets: { sessionId: 'session' } },
    permission: 'workspace',
    params: SessionAddressParams,
    // Only host records know the chat's /clear root.
    handler: (params, { runtime }): OrchestrationSessionAddressResult => {
      if (!isOrcaSessionId(params.sessionId)) {
        throw new OrchestrationError(
          CODES.unknown,
          `${params.sessionId} is not an Orca session ID.`,
          { effectsApplied: false }
        )
      }
      const party = resolveOrcaSessionParty(params.sessionId, runtime.getOrchestrationDb())
      return { orcaSessionId: formatOrcaSessionAddress(party.orcaSessionId) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.partyLocation',
    access: { kind: 'reads', targets: { address: 'party', messageIds: 'message' } },
    permission: 'workspace',
    params: PartyLocationParams,
    // Resolve the chat sender's live /clear successor on its owning host.
    handler: (params, ctx): Promise<OrchestrationPartyLocationResult> => locateParty(params, ctx)
  }),
  defineOrchestrationMethod({
    name: 'orchestration.partyOpen',
    access: { kind: 'localOnly', targets: { address: 'party', messageIds: 'message' } },
    permission: 'workspace',
    params: PartyLocationParams,
    // The lookup, except that a terminal worker Orca closed resumes its conversation in a new terminal.
    handler: async (params, ctx): Promise<OrchestrationPartyLocationResult> => {
      const located = await locateParty(params, ctx)
      const db = ctx.runtime.getOrchestrationDb()
      const handle = db && closedWorkerHandle(params.address, located, db)
      const reopened = handle ? await openClosedWorkerTerminal(ctx.runtime, db, handle) : null
      return reopened ? { location: reopened } : located
    }
  })
]
