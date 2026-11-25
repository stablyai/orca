import { resolveChatAutomationRun } from './automation-chat-run-observation'

import type { JournalPublication } from '../../native-chat/agent-session-wire/host/structured-agent-session-conversations'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readAutomationRunReceipt } from '../launch/automation-run-receipt'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import { tuiAgentDisplayName } from '../../../shared/agent-launch/catalog/tui-agent-display-names'

export async function observeAutomationChatRun(
  runtime: OrcaRuntimeService,
  run: AutomationRun,
  signal: AbortSignal
): Promise<AutomationRunCompletionObservation> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host || !run.chatSessionId) {
    throw new Error('Chat session unavailable')
  }
  const store = await runtime.openAgentSessionRecordStore()
  const receipt = readAutomationRunReceipt(store, run)
  const agent =
    tuiAgentDisplayName(store.getConversation(run.chatSessionId)?.provider ?? 'Agent') ?? 'Agent'
  if (
    receipt?.kind !== 'chat' ||
    receipt.sessionId !== run.chatSessionId ||
    !receipt.messageId ||
    !receipt.accepted
  ) {
    return {
      status: 'dispatch_failed',
      error: `${agent} could not confirm this run's prompt. Open the chat before running again.`
    }
  }
  const messageId = receipt.messageId
  const sessionId = run.chatSessionId
  return new Promise((resolve, reject) => {
    let release: (() => void) | undefined
    let settled = false
    let reading = false
    let dirty = false
    let fingerprint = ''
    let observed = Promise.resolve()
    let source: JournalPublication['source'] = null
    let currentJournal: JournalPublication['journal'] = null
    let cursor: JournalPublication['cursor']
    let revision = 0
    let submissionId = messageId
    let providerItemId: string | null = null
    let turnItemId: string | null = null
    const finish = (result?: AutomationRunCompletionObservation, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      source = null
      currentJournal = null
      cursor = undefined
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      release?.()
      if (error) {
        reject(error)
      } else {
        resolve(result!)
      }
    }
    const abort = (): void => finish(undefined, new Error('request_aborted'))
    const deadline = setTimeout(
      () =>
        finish({
          status: 'dispatch_failed',
          error: `${agent} did not report a result within 6 hours. Open the chat before running again.`
        }),
      Math.max(1, (run.dispatchedAt ?? run.createdAt) + 6 * 60 * 60 * 1000 - Date.now())
    )
    // Keys and reads start when called, so a later turn id cannot change an earlier hint's answer.
    const interest = async (): Promise<string> => {
      const journal = currentJournal
      const card = await journal?.queuedMessages.get(messageId)
      const turnId = turnItemId
      const [entry, root] = await Promise.all([
        journal?.reads.submission(card?.consumedAs ?? submissionId),
        journal && turnId
          ? journal.reads.canonicalItemId(turnId).then((id) => journal.reads.item(id))
          : null
      ])
      const turn = root ? readAgentJournalTurn(root.body) : null
      return JSON.stringify([
        card?.state,
        card?.consumedAs,
        entry?.clientMessageId,
        entry?.dispatchState,
        entry?.providerItemId,
        entry?.answeredInTurn,
        root && turn
          ? [root.itemId, turn.userItemId, turn.state, readAgentJournalTurnOutcome(turn)]
          : null
      ])
    }
    const read = async (): Promise<void> => {
      if (settled) {
        return
      }
      if (reading) {
        return
      }
      reading = true
      try {
        do {
          dirty = false
          const version = revision
          const readingSource = source
          const current = () => !settled && version === revision && readingSource === source
          const snapshot = await host.automationRun(sessionId, messageId, [submissionId])
          if (!current()) {
            continue
          }
          const queued = await host.queuedSendAnswer(sessionId, messageId)
          if (!current()) {
            continue
          }
          const { submission, turnItem, observation } = resolveChatAutomationRun(
            snapshot,
            messageId,
            agent,
            queued
          )
          if (submission) {
            submissionId = submission.clientMessageId
            providerItemId = submission.providerItemId
            turnItemId = turnItem?.itemId ?? null
          }
          const semantic = interest()
          const recorded = observed
            .then(() => semantic)
            .then((value) => {
              fingerprint = value
            })
          observed = recorded.catch(() => {})
          await recorded
          if (observation) {
            finish(observation)
            return
          }
        } while (dirty && !settled)
      } catch (error) {
        if (!dirty) {
          finish(undefined, error)
        }
      } finally {
        reading = false
        if (dirty && !settled) {
          queueMicrotask(() => void read())
        }
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    release = host.observeConversationPublications(sessionId, {
      next: (hint) => {
        if (settled) {
          return
        }
        if (hint.kind === 'end') {
          finish(undefined, new Error('Chat session host stopped'))
          return
        }
        currentJournal = hint.journal
        const commit = hint.commit
        const publication = commit?.publication
        const currentCursor = cursor
        const contiguous =
          currentCursor &&
          commit &&
          hint.cursor?.epoch === currentCursor.epoch &&
          hint.cursor.sequence >= currentCursor.sequence
        const linked =
          publication?.cards.some(
            (card) =>
              card.messageId === messageId &&
              card.consumedAs !== undefined &&
              card.consumedAs !== submissionId
          ) ||
          publication?.items.some((item) => {
            const turn = readAgentJournalTurn(item.body)
            return (
              (item.body.kind === 'message' && item.body.role === 'user') ||
              (turn &&
                !turnItemId &&
                !item.agentId &&
                (providerItemId === null ||
                  turn.userItemId === providerItemId ||
                  turn.userItemId === agentJournalSubmissionKey(submissionId)))
            )
          })
        const structural = source !== hint.source || hint.kind !== 'commit' || !contiguous || linked
        source = hint.source
        cursor = hint.cursor
        const reread = (): void => {
          revision++
          dirty = true
          queueMicrotask(() => void read())
        }
        if (structural) {
          reread()
        }
        // Chained so each hint compares against the fingerprint recorded before it.
        const semantic = interest()
        observed = observed
          .then(() => semantic)
          .then((value) => {
            const changed = value !== fingerprint
            fingerprint = value
            if (changed && !structural && !settled) {
              reread()
            }
          })
          .catch((error: unknown) => finish(undefined, error))
      },
      error: (error) => finish(undefined, error)
    })
    if (settled) {
      release()
    }
  })
}
