import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { resolveRunScope } from '../runs/run-scope'
import { InboxParams } from '../schemas'

export const ORCHESTRATION_INBOX_METHOD = defineMethod({
  name: 'orchestration.inbox',
  params: InboxParams,
  handler: (
    params,
    { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
  ) => {
    const db = runtime.getOrchestrationDb()
    if (params.run) {
      if (!params.terminal) {
        throw new OrchestrationError(
          'terminal_required',
          'Run-scoped inbox reads require a terminal. Run this command inside a live Orca terminal or pass --terminal <handle>.'
        )
      }
      const callerPaneKey = runtime.getTerminalPaneKey(params.terminal) ?? params.terminalPaneKey
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.terminal,
        callerPaneKey,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const messages = db.getRunMailboxHistory(run.id, params.limit)
      return {
        messages,
        count: messages.length,
        scope: `messages addressed to Run ${run.id}`,
        runBinding: run.id
      }
    }
    // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
    if (params.terminal) {
      const party = resolveOrchestrationParty(params.terminal, db)
      // Why: the terminal's live pane is authoritative, while session parties retain their recorded identity.
      const livePaneKey = party.terminalHandle
        ? runtime.getTerminalPaneKey(party.terminalHandle)
        : null
      const boundRun = db.getCurrentRunForCoordinator({
        ...party,
        paneKey: livePaneKey ?? party.paneKey
      })
      const messages = db.getAllMessagesForHandle(party.address, params.limit)
      return {
        messages,
        count: messages.length,
        scope: `messages addressed to terminal ${params.terminal}`,
        runBinding: boundRun?.id ?? null
      }
    }
    const messages = db.getInbox(params.limit)
    return { messages, count: messages.length, scope: 'messages across all recipients' }
  }
})
