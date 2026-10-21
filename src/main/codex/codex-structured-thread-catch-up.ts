import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { createCodexHistoryImportPlan } from './codex-history-import-plan'
import { discoverCodexHistory, loadCodexHistory } from './codex-structured-thread-history-pages'
import {
  readCodexHistoryJournalView,
  sameCodexHistoryJournalView
} from './codex-history-journal-view'

// A chat writes its conversation only while its own app-server holds Codex's writer lock, so turns
// made anywhere else land only while the chat has no process; every process start opens here.

/** Optional reconciliation never gates provider open; an abandoned invocation cannot later write. */
export async function catchUpCodexThread(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) {
    abort()
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(new Error('catch-up-deadline')), timeoutMs)
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new Error('catch-up-cancelled')
    }
    input.assertCurrent?.()
  }
  const warn = (reason: string, error?: unknown) =>
    input.logger?.warn('Codex chat did not catch up on turns made outside it', {
      scope: 'codex-thread-catch-up',
      sessionId: input.sessionId,
      reason,
      ...(error === undefined ? {} : { error })
    })
  let staging: ReturnType<typeof createCodexHistoryImportPlan> | undefined
  try {
    check()
    const written = await waitForPromiseWithSignal(
      input.sink.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    check()
    const history = input.sink.journalHistory?.()
    const journal = input.sink.journalItems?.()
    if (!history || !journal || !written.ok || !input.sink.tryAppendTransition) {
      return
    }
    const view = readCodexHistoryJournalView(history, input.threadId)
    const read = {
      connection: input.connection,
      threadId: input.threadId,
      signal: controller.signal,
      deadline,
      check
    }
    const missing = await discoverCodexHistory(read, view)
    if (missing.pages.length === 0) {
      return
    }
    staging = createCodexHistoryImportPlan({
      sessionId: input.sessionId,
      threadId: input.threadId,
      journal,
      nativePromptKeys: view.nativePromptKeys,
      outsideNotice: view.hasRows
        ? agentSessionHostStatusBody(
            missing.rewound ? 'continued-outside-rewound' : 'continued-outside'
          )
        : undefined,
      check
    })
    for await (const turn of loadCodexHistory(read, missing.pages)) {
      check()
      staging.restore(turn)
      await setImmediate()
    }
    const plan = staging.finish()
    let resolved = false
    const admission = input.sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolve: (current) => {
            try {
              check()
            } catch {
              return []
            }
            if (
              current.epoch !== view.epoch ||
              input.sink.journalHistory?.() !== history ||
              !sameCodexHistoryJournalView(
                view,
                readCodexHistoryJournalView(history, input.threadId)
              )
            ) {
              return []
            }
            if (plan.keys.some((key) => current.item(current.canonicalItemId(key)) !== null)) {
              return []
            }
            // Canonical keys can also collide with one another through an existing submission alias.
            if (
              new Set(plan.keys.map((key) => current.canonicalItemId(key))).size !==
              plan.keys.length
            ) {
              return []
            }
            resolved = true
            return plan.mutations
          }
        }
      ]
    })
    if (!admission.accepted) {
      warn(admission.reason)
      return
    }
    const committed = await input.sink.written?.()
    if (committed?.ok === false) {
      warn('write-failed', committed.error)
    } else if (!resolved) {
      warn('stale-history')
    }
  } catch (error) {
    warn('import-skipped', error)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
    staging?.dispose()
  }
}
