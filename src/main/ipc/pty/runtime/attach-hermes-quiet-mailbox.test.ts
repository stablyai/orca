import '../../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { OrchestrationDb } from '../../../runtime/orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../runtime/orchestration/db/root-dispatch-test-fixture'
import {
  createRuntime,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE
} from '../../../runtime/orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'
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

describe('mail to a quiet idle Hermes after a runtime restart', () => {
  // Real Hermes 0.23 writes its OSC title only on a state change, so a worker idle before the
  // restart sends no title after reattach; only its ready screen and seeded title are known.
  it('types and submits the pointer without a fresh title', async () => {
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
          snapshot:
            '\x1b]2;\u2713 Coordinate dispatched worker \u2026 \u00b7 gpt-6.1-sol \u00b7 ~/ws\x07' +
            '\u2500 ready \u2502 gpt 6.1 sol \u2502 7k/500k \u2502 4m 45s\r\n\u276f',
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
        objective: 'wake quiet worker',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'coordinator:leaf'
      })
      const task = db.createTask({ spec: 'Wait for guidance', runId: run.id })
      const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
      const mailbox = `dispatch:${dispatch.id}`
      const message = db.insertMessage({
        from: 'term_coordinator',
        to: mailbox,
        subject: 'Continue',
        runId: run.id
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach needs runtime; its delivery callbacks are optional.
      const deps = { runtime } as unknown as PtyRuntimeControllerDeps
      expect(await attachPtyFromRuntimeController(deps, PTY_ID)).toBe(true)
      await runtime.serializeMainTerminalBuffer(PTY_ID)
      runtime.notifyMessageArrived(mailbox, 'status')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    } finally {
      db.close()
    }
  })
})
