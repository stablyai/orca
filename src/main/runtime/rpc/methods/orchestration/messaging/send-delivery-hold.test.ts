import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'
import { settledWriteStub } from '../../../../../providers/testing/settled-pty-write-stub'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-titleless'
const RECIPIENT = 'term_titleless'
const WORKTREE_ID = 'repo-receipt::/tmp/receipt'

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

  function send(ctx: { runtime: OrcaRuntimeService }, to = RECIPIENT): Promise<unknown> {
    return harness.call('orchestration.send', { from: 'term_coord', to, subject: 'status?' }, ctx)
  }

  function heldWarning(recipient: string, command: string) {
    return {
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: 'recipient_delivery_held',
          recipient,
          message: expect.stringContaining(
            `The agent in ${RECIPIENT} can read it by running \`${command}\` in its own terminal; don't run this yourself or type into its terminal.`
          )
        })
      ])
    }
  }

  it('warns that the agent is not notified and names the check it can run', async () => {
    const { ctx } = await setupTitlelessRecipient()

    const result = await send(ctx)

    expect(result).toMatchObject({ message: { to_handle: RECIPIENT } })
    expect(result).toMatchObject(
      heldWarning(RECIPIENT, 'orca-dev orchestration check --terminal term_titleless')
    )
  })

  it('does not warn when the recipient is already waiting in check --wait', async () => {
    const { ctx, runtime } = await setupTitlelessRecipient()
    const waiting = runtime.waitForMessage(RECIPIENT, { timeoutMs: 5_000 })

    const result = await send(ctx)

    expect(result).not.toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'recipient_delivery_held' })
      ])
    })
    await expect(waiting).resolves.toBeInstanceOf(MessageWake)
  })

  it("names the addressed Run in its coordinator's check", async () => {
    const { ctx, db } = await setupTitlelessRecipient()
    const run = db.createRun({
      objective: 'Coordinated from the title-less terminal',
      coordinatorHandle: RECIPIENT,
      coordinatorPaneKey: PANE_KEY
    })

    const result = await send(ctx)

    expect(result).toMatchObject({ message: { to_handle: `run:${run.id}` } })
    expect(result).toMatchObject(
      heldWarning(
        `run:${run.id}`,
        `orca-dev orchestration check --run ${run.id} --terminal term_titleless`
      )
    )
  })

  it("says a coordinator's context-only Dispatch mail is not read in its terminal", async () => {
    const { ctx, db } = await setupTitlelessRecipient()
    const run = db.createRun({
      objective: 'Coordinated from the title-less terminal',
      coordinatorHandle: RECIPIENT,
      coordinatorPaneKey: PANE_KEY
    })
    const task = db.createTask({ spec: 'self-assigned context', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, RECIPIENT, PANE_KEY)

    const result = await send(ctx, `dispatch:${dispatch.id}`)

    expect(result).toMatchObject({
      message: { to_handle: `dispatch:${dispatch.id}` },
      warnings: expect.arrayContaining([
        {
          code: 'recipient_delivery_held',
          recipient: `dispatch:${dispatch.id}`,
          message: `Queued for dispatch:${dispatch.id}, but the agent in term_titleless reads its Run's mail (run:${run.id}), so Orca won't notify it of this message and its own check won't read it. Message term_titleless directly instead.`
        }
      ])
    })
  })
})
