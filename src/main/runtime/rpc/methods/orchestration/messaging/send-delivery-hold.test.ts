import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'
import { settledWriteStub } from '../../../../../providers/testing/settled-pty-write-stub'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-titleless'
const RECIPIENT = 'term_titleless'
const WORKTREE_ID = 'repo-receipt::/tmp/receipt'

type SendResult = {
  message: { to_handle: string }
  warnings?: { code: string; recipient: string; message: string }[]
}

describe('send receipt for a terminal Orca cannot notify', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  /** A live terminal whose program never reported a status: no title, no launch agent. */
  async function setupTitlelessRecipient() {
    const state = harness.setup()
    const { runtime } = state
    const realPaneKey = OrcaRuntimeService.prototype.getTerminalPaneKey
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? harness.coordinatorPaneKey : realPaneKey.call(runtime, handle)
    )
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'titleless'
    })
    runtime.registerPreAllocatedHandleForPty(PTY_ID, RECIPIENT)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'cli',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, leafId: LEAF_ID, worktreeId: WORKTREE_ID, paneRuntimeId: 1, ptyId: PTY_ID }
      ]
    })
    runtime.onPtyData(PTY_ID, 'working on it\r\n', 1)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    return state
  }

  function send(ctx: { runtime: OrcaRuntimeService }) {
    return harness.call(
      'orchestration.send',
      { from: 'term_coord', to: RECIPIENT, subject: 'status?' },
      ctx
    ) as Promise<SendResult>
  }

  it('warns that the agent is not notified and names the check it can run', async () => {
    const { ctx } = await setupTitlelessRecipient()

    const result = await send(ctx)

    expect(result.message.to_handle).toBe(RECIPIENT)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'recipient_delivery_held',
        recipient: RECIPIENT,
        message: expect.stringContaining(`orca orchestration check --terminal ${RECIPIENT}`)
      })
    )
  })

  it('does not warn when the recipient is already waiting in check --wait', async () => {
    const { ctx, runtime } = await setupTitlelessRecipient()
    const waiting = runtime.waitForMessage(RECIPIENT, { timeoutMs: 5_000 })

    const result = await send(ctx)

    expect(result.warnings ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'recipient_delivery_held' })
    )
    await expect(waiting).resolves.toBeInstanceOf(MessageWake)
  })

  it("reports a Run recipient's coordinator terminal", async () => {
    const { ctx, db } = await setupTitlelessRecipient()
    const run = db.createRun({
      objective: 'Coordinated from the title-less terminal',
      coordinatorHandle: RECIPIENT,
      coordinatorPaneKey: PANE_KEY
    })

    const result = await send(ctx)

    expect(result.message.to_handle).toBe(`run:${run.id}`)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'recipient_delivery_held',
        recipient: `run:${run.id}`,
        message: expect.stringContaining(`orca orchestration check --terminal ${RECIPIENT}`)
      })
    )
  })
})
