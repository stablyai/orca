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

const HERMES_READY =
  '\x1b]2;\u2713 Coordinate dispatched worker \u2026 \u00b7 gpt-6.1-sol \u00b7 ~/ws\x07' +
  '\u2500 ready \u2502 gpt 6.1 sol \u2502 7k/500k \u2502 4m 45s\r\n\u276f'
const RULE = '\u2500'.repeat(40)
const CLINE_READY = `${RULE}\r\n\u276f What can I do for you?\r\n${RULE}\r\n\u25cb Plan \u25cf Act (Tab)`

async function mailAfterQuietAttach(
  agent: 'hermes' | 'cline',
  snapshot: string,
  afterAttach: (runtime: ReturnType<typeof createRuntime>['runtime']) => Promise<void>
): Promise<{ writes: string[]; delivered: boolean }> {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  try {
    const { runtime } = createRuntime(db, { headless: true, launchAgent: agent })
    const write = vi.fn((_id: string, _data: string) => true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach reads only this provider's attach method.
    const provider = {
      attach: async () => ({
        id: PTY_ID,
        isReattach: true,
        snapshot,
        snapshotCols: 120,
        snapshotRows: 40
      })
    } as unknown as IPtyProvider
    setLocalPtyProvider(provider)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => agent,
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
    await afterAttach(runtime)
    runtime.notifyMessageArrived(mailbox, 'status')
    await vi.advanceTimersByTimeAsync(60_000)
    return {
      writes: write.mock.calls.map(([, data]) => data),
      delivered: typeof db.getMessageById(message.id)?.delivered_at === 'string'
    }
  } finally {
    db.close()
  }
}

describe('mail to a quiet idle agent after a runtime restart', () => {
  // Real Hermes 0.23 writes its OSC title only on a state change, so a worker idle before the
  // restart sends no title after reattach; only its ready screen and seeded title are known.
  it('types and submits the pointer to Hermes without a fresh title', async () => {
    expect(await mailAfterQuietAttach('hermes', HERMES_READY, async () => {})).toEqual({
      writes: [expect.stringContaining('You have 1 orchestration message'), '\r'],
      delivered: true
    })
  })

  // A quiet-gated ready rule must still settle once a redraw soon after attach has gone quiet.
  it('submits to Cline once its ready screen is quiet after a redraw', async () => {
    const result = await mailAfterQuietAttach('cline', CLINE_READY, async (runtime) => {
      await vi.advanceTimersByTimeAsync(2_000)
      runtime.onPtyData(PTY_ID, '\x1b[H', Date.now())
    })
    expect(result).toEqual({
      writes: [expect.stringContaining('You have 1 orchestration message'), '\r'],
      delivered: true
    })
  })
})
