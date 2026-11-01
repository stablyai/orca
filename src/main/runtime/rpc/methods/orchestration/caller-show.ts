import type {
  OrchestrationCallerShowResult,
  OrchestrationPartyLocationResult,
  OrchestrationSessionAddressResult
} from '../../../../../shared/orchestration-caller-status'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../shared/orchestration-session-caller-codes'
import {
  PartyLocationParams,
  SessionAddressParams
} from '../../../../../shared/rpc-contract/orchestration-params'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { resolveOrcaSessionParty } from '../../../orchestration/orchestration-party'
import { locateOrchestrationParty } from '../../../orchestration/orchestration-party-location'
import { readAgentSessionRecordStore } from '../../../orchestration/structured-session-lineage'
import type { z } from 'zod'
import type { OrchestrationDb } from '../../../orchestration/db'
import { defineMethod, type RpcContext } from '../../core'
import { openClosedWorkerChat } from './worker/closed-worker-chat'
import { ensureStructuredHostInstalled } from '../structured-agent-session-gate'

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
  defineMethod({
    name: 'orchestration.callerShow',
    permission: 'workspace',
    params: null,
    // Dispatch already admitted the environment's session; do not resolve another caller from params.
    handler: (_params, { orchestrationCaller }): OrchestrationCallerShowResult => ({
      caller: orchestrationCaller
        ? { orcaSessionId: formatOrcaSessionAddress(orchestrationCaller.orcaSessionId), live: true }
        : null
    })
  }),
  defineMethod({
    name: 'orchestration.sessionAddress',
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
  defineMethod({
    name: 'orchestration.partyLocation',
    permission: 'workspace',
    params: PartyLocationParams,
    // Resolve the chat sender's live /clear successor on its owning host.
    handler: (params, ctx): Promise<OrchestrationPartyLocationResult> => locateParty(params, ctx)
  }),
  defineMethod({
    name: 'orchestration.partyOpen',
    permission: 'workspace',
    params: PartyLocationParams,
    // The lookup, except that a terminal worker Orca closed opens as a chat of its conversation.
    handler: async (params, ctx): Promise<OrchestrationPartyLocationResult> => {
      const located = await locateParty(params, ctx)
      const db = ctx.runtime.getOrchestrationDb()
      const handle = db && closedWorkerHandle(params.address, located, db)
      const chat = handle ? await openClosedWorkerChat(ctx, db, handle) : null
      return chat ? { location: chat } : located
    }
  })
]
