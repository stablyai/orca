import '../../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { OrchestrationDb } from '../../../runtime/orchestration/db'
import { createRootDispatch } from '../../../runtime/orchestration/db/root-dispatch-test-fixture'
import {
  createRuntime,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE
} from '../../../runtime/orchestration-mailbox-notification-test-harness'
import { ptySizes } from '../delivery/visibility-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { attachPtyFromRuntimeController, getSizeFromRuntimeController } from './operations'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const originalProvider = getLocalPtyProvider()

afterEach(() => {
  setLocalPtyProvider(originalProvider)
  ptySizes.delete(PTY_ID)
  vi.useRealTimers()
})

describe('mail to a Hermes terminal attached without a renderer', () => {
  it.each([
    ['status', '─ ready │ grok 4.7 │ 150k tokens\r\n❯', true],
    ['reply', '─ ready │ grok 4.7 │ 150k tokens\r\n❯', true],
    ['draft', '─ ready │ grok 4.7 │ 150k tokens\r\n❯ unsent draft', false],
    ['busy', '─ thinking │ grok 4.7 │ 150k tokens\r\n❯ Ctrl+C to interrupt…', false]
  ] as const)(
    'handles %s mail after attach without submitting a draft or busy composer',
    async (kind, screen, ready) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      try {
        const { runtime } = createRuntime(db, { headless: true, launchAgent: 'hermes' })
        const write = vi.fn((_id: string, _data: string) => true)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach reads only this provider's attach method.
        const provider = {
          attach: async () => ({
            id: PTY_ID,
            isReattach: true,
            snapshot: screen,
            snapshotCols: 120,
            snapshotRows: 40
          })
        } as unknown as IPtyProvider
        setLocalPtyProvider(provider)
        runtime.setPtyController({
          write,
          writeWithSettlement: settledWriteStub(write),
          kill: () => true,
          getForegroundProcess: async () => 'hermes',
          getSize: getSizeFromRuntimeController
        })
        const run = db.createRun({
          objective: 'wake attached worker',
          coordinatorHandle: 'term_coordinator',
          coordinatorPaneKey: 'coordinator:leaf'
        })
        const task = db.createTask({ spec: 'Wait for guidance', runId: run.id })
        const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
        const mailbox = `dispatch:${dispatch.id}`
        const message =
          kind === 'reply'
            ? db.answerQuestion({
                messageId: db.createQuestion({
                  runId: run.id,
                  dispatchId: dispatch.id,
                  askerHandle: TERMINAL_HANDLE,
                  question: 'Ready?'
                }).message.id,
                runId: run.id,
                consumerGeneration: run.consumer_generation,
                body: 'Continue'
              }).message
            : db.insertMessage({
                from: 'term_coordinator',
                to: mailbox,
                subject: 'Continue',
                runId: run.id
              })

        // Only attach and restored output: no renderer spawn or resize populates the size cache.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach needs runtime; its delivery callbacks are optional.
        const deps = { runtime } as unknown as PtyRuntimeControllerDeps
        expect(await attachPtyFromRuntimeController(deps, PTY_ID)).toBe(true)
        await runtime.serializeMainTerminalBuffer(PTY_ID)
        runtime.onPtyData(PTY_ID, '\x1b]0;Hermes ready\x07', Date.now())
        runtime.notifyMessageArrived(mailbox, 'status')
        await vi.advanceTimersByTimeAsync(1000)

        if (ready) {
          expect(write.mock.calls.map(([, data]) => data)).toEqual([
            expect.stringContaining('You have 1 orchestration message'),
            '\r'
          ])
          expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
        } else {
          expect(write).not.toHaveBeenCalled()
          expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
        }
      } finally {
        db.close()
      }
    }
  )
})
