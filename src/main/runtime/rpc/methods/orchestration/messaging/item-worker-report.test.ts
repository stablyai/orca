import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import type { BotItemRecord } from '../../../../../bots/bot-items-schema'

const PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINE =
  '[This worker was started for item 34, "Item comment box: click anywhere to focus + paste images" (In progress). Done means: Click-to-focus merged; image paste mocked, signed off, built and merged. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 34.]'
const ITEM = {
  uid: 'item_uid_34',
  number: 34,
  title: 'Item comment box: click anywhere to focus + paste images',
  status: 'working' as const,
  doneMeans: 'Click-to-focus merged; image paste mocked, signed off, built and merged.'
}

type Checked = {
  messages: { subject: string; payload: string | null; for_item?: unknown }[]
  formatted: string
}

describe("a finished item worker's report", () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  /** A worker started for `origin` (and, with `followUp`, its follow-up) reports done; the coordinator checks. */
  async function reportAndCheck(
    origin: string | undefined,
    item: () => Promise<Partial<BotItemRecord> | null>,
    options: { followUp?: boolean } = {}
  ) {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    const get = vi.fn(item)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a report's item line reads only `get`.
    vi.spyOn(runtime.botItems, 'store').mockReturnValue({ get } as unknown as BotItemsRemote)
    const start = (followUpOf?: string) => {
      const started = db.createStartingWorkerDispatch({
        taskSpec: 'Build it',
        taskRunId: activeRunId,
        startOptions: {},
        runtimeEpoch: 'epoch',
        creator: { kind: 'terminal', handle: 'term_coord', paneKey: harness.coordinatorPaneKey },
        maxDepth: 10,
        originRef: followUpOf ? undefined : origin,
        followUpOf
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_worker',
        paneKey: PANE,
        processIncarnation: 'process_one',
        worktreeId: 'wt',
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      return started
    }
    const report = ({ task, dispatch }: ReturnType<typeof start>) => {
      const payload = JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded'
      })
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Done',
        body: 'Merged the click-to-focus PR.',
        type: 'worker_done',
        payload,
        senderPaneKey: PANE
      })
      return payload
    }
    let started = start()
    if (options.followUp) {
      report(started)
      // The coordinator reads the first report, which settles its Dispatch; then sends more work.
      await harness.call('orchestration.check', { terminal: 'term_coord' }, ctx)
      started = start(started.dispatch.id)
    }
    const payload = report(started)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orchestration.check with format answers messages and formatted text.
    const checked = (await harness.call(
      'orchestration.check',
      { terminal: 'term_coord', format: true },
      ctx
    )) as Checked
    return { checked, payload, get, db, activeRunId, origin: started.dispatch.origin_ref }
  }

  it('names the open item, as it is now, after the follow-up line', async () => {
    const { checked, payload, db, activeRunId } = await reportAndCheck(
      `bot-item:${ITEM.uid}`,
      async () => ITEM
    )
    expect(checked.messages[0]).toMatchObject({ subject: 'Done', payload })
    expect(checked.messages[0].for_item).toEqual({
      number: 34,
      title: ITEM.title,
      status: 'working' as const,
      doneMeans: ITEM.doneMeans
    })
    const lines = checked.formatted.split('\n')
    expect(checked.messages).toHaveLength(1)
    expect(lines.at(-2)).toBe(LINE)
    expect(lines.at(-3)).toMatch(/^\[To give this worker more work: /)
    // The stored report and its delivery are untouched.
    expect(db.getRunMailboxHistory(activeRunId!, 10)[0]).toMatchObject({ payload, read: 1 })
  })

  it("names the item on a follow-up's report, which keeps its earlier start's item", async () => {
    const { checked, get, origin } = await reportAndCheck(
      `bot-item:${ITEM.uid}`,
      async () => ({ ...ITEM, status: 'needs_you' as const, doneMeans: null }),
      { followUp: true }
    )
    expect(origin).toBe(`bot-item:${ITEM.uid}`)
    expect(get).toHaveBeenCalledWith(ITEM.uid)
    expect(checked.formatted.split('\n').at(-2)).toBe(
      '[This worker was started for item 34, "Item comment box: click anywhere to focus + paste images" (Needs you). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 34.]'
    )
  })

  it.each([
    ['a closed item', async () => ({ ...ITEM, status: 'done' as const })],
    ['a canceled item', async () => ({ ...ITEM, status: 'canceled' as const })],
    ['a missing item', async () => null],
    [
      'a failed lookup',
      async () => {
        throw new Error('items DB worker gone')
      }
    ]
  ])('shows the report without an item line for %s', async (_case, item) => {
    const { checked, payload } = await reportAndCheck(`bot-item:${ITEM.uid}`, item)
    expect(checked.messages).toHaveLength(1)
    expect(checked.messages[0]).toMatchObject({ subject: 'Done', payload })
    expect(checked.messages[0].for_item).toBeUndefined()
    expect(checked.formatted).not.toContain('This worker was started for item')
  })

  it("never reads items for a worker that wasn't started for one", async () => {
    const { checked, get } = await reportAndCheck(undefined, async () => ITEM)
    expect(get).not.toHaveBeenCalled()
    expect(checked.messages[0].for_item).toBeUndefined()
    expect(checked.formatted).not.toContain('This worker was started for item')
  })
})
