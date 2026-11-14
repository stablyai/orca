import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveOrchestrationParty } from '../../../../orchestration/addressing/orchestration-party'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import { resolveRunScope } from '../runs/run-scope'
import { InboxParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'

type ExposedMessage = Omit<MessageRow, 'answer_sender_snapshot'>

function exposeInboxRows(rows: MessageRow[]): ExposedMessage[] {
  return rows.map(({ answer_sender_snapshot: _answer, ...message }) => message)
}

export const ORCHESTRATION_INBOX_METHOD = defineOrchestrationMethod({
  name: 'orchestration.inbox',
  permission: 'workspace',
  params: InboxParams,
  access: {
    kind: 'reads',
    callerPane: 'terminalPaneKey',
    targets: { terminal: 'party', run: 'run' },
    collection: true
  },
  handler: (
    params,
    { orchestrationCaller, orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }
  ) => {
    const db = runtime.getOrchestrationDb()
    // A paired Orca's narrowed read keeps its filter; an explicit Run read by a local caller is fenced to the Run's current consumer.
    if (params.run && orchestrationCaller?.kind !== 'peer') {
      if (!params.terminal) {
        throw new OrchestrationError(
          'terminal_required',
          'Run-scoped inbox reads require a terminal. Run this command inside a live Orca terminal or pass --terminal <handle>.'
        )
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.terminal,
        // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
        callerPaneKey: runtime.getTerminalPaneKey(params.terminal) ?? params.terminalPaneKey,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const messages = db.getRunMailboxHistory(run.id, params.limit)
      return {
        messages: exposeInboxRows(messages),
        count: messages.length,
        scope: `messages addressed to Run ${run.id}`,
        runBinding: run.id
      }
    }
    // Return empty for stale/unknown handles because historical mail outlives handle deletion (design doc §3.3).
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
      const messages = db.getAllMessagesForHandle(
        party.address,
        params.limit,
        undefined,
        params.run
      )
      return {
        messages: exposeInboxRows(messages),
        count: messages.length,
        scope: `messages addressed to terminal ${params.terminal}`,
        runBinding: boundRun?.id ?? null
      }
    }
    const messages = db.getInbox(params.limit, params.run)
    return {
      messages: exposeInboxRows(messages),
      count: messages.length,
      scope: params.run ? `messages in Run ${params.run}` : 'messages across all recipients'
    }
  }
})
