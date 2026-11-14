import { expect, it, vi } from 'vitest'
import { moveStructuredAgentSessionChatsToSelectedAccount } from '../../recovery/structured-agent-session-account-switch'
import { createRestTestRig, foundRestTestChat } from './structured-agent-session-rest-test-rig'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'
import {
  accountHome,
  chatOwingBackgroundTask,
  dispatchedTexts,
  MOVED_MESSAGE,
  MOVED_NOTE,
  rows,
  selectB,
  sendWith
} from './structured-agent-session-account-switch.test-support'

it('restart-all moves a chat owing a background task to the selected account unasked', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await chatOwingBackgroundTask(f)
    await selectB(f, 'restart-all')
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
    expect(dispatchedTexts(f)).toEqual(['start the dev server', MOVED_MESSAGE])
    expect((await rows(f)).slice(-2)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: MOVED_MESSAGE }] },
      { kind: 'status', text: MOVED_NOTE }
    ])
    await selectB(f, 'restart-all')
    expect(f.launches).toHaveLength(2)
    expect(dispatchedTexts(f)).toHaveLength(2)
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
  } finally {
    await f.dispose()
  }
})

it('restart leaves a chat owing a background task on its launch account', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await chatOwingBackgroundTask(f)
    await selectB(f, 'restart')
    expect(f.launches).toEqual([accountHome(f, 'a')])
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeA)
    expect(dispatchedTexts(f)).toEqual(['start the dev server'])
  } finally {
    await f.dispose()
  }
})

it('restart-all waits out a send being handed over, then moves the chat', async () => {
  const f = await createReceivingCallerFixture()
  const handingOver = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<void>()
  try {
    await f.found()
    const accept = f.rig.adapter.dispatch.getMockImplementation()!
    f.rig.adapter.dispatch.mockImplementationOnce(async (input) => {
      handingOver.resolve()
      await answer.promise
      return accept(input)
    })
    const id = await f.accept('write the report')
    await handingOver.promise
    const moved = selectB(f, 'restart-all')
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeA)
    answer.resolve()
    await moved
    const journal = f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal
    await vi.waitFor(() => expect(journal?.submission(id)?.dispatchState).toBe('accepted'))
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['write the report', MOVED_MESSAGE])
  } finally {
    answer.resolve()
    await f.dispose()
  }
})

it('restart-all leaves a chat already on the selected account at once, even mid-send', async () => {
  const f = await createReceivingCallerFixture()
  const handingOver = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<void>()
  try {
    f.selectB()
    await f.found()
    const accept = f.rig.adapter.dispatch.getMockImplementation()!
    f.rig.adapter.dispatch.mockImplementationOnce(async (input) => {
      handingOver.resolve()
      await answer.promise
      return accept(input)
    })
    const id = await f.accept('write the report')
    await handingOver.promise
    expect(f.launches).toEqual([accountHome(f, 'b')])
    const moved = selectB(f, 'restart-all').then(() => 'returned')
    const waiting = new Promise((resolve) => setTimeout(resolve, 200, 'waiting'))
    expect(await Promise.race([moved, waiting])).toBe('returned')
    answer.resolve()
    const journal = f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal
    await vi.waitFor(() => expect(journal?.submission(id)?.dispatchState).toBe('accepted'))
    expect(f.launches).toEqual([accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['write the report'])
  } finally {
    answer.resolve()
    await f.dispose()
  }
})

it('restart-all hands a queued send to the selected account instead of continuing', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    const id = await f.send('refactor the parser')
    await f.turn(id, 'running')
    const queued = await sendWith(f, 'then add tests', {
      userSend: true,
      delivery: 'queue-if-active'
    })
    const submission = async () =>
      (await f.rig.host.journalSnapshot(PARENT)).submissions.findLast(
        (entry) => entry.queuedMessageId === queued
      )
    expect(await submission()).toBeUndefined()
    await selectB(f, 'restart-all')
    await vi.waitFor(async () => expect((await submission())?.dispatchState).toBe('accepted'))
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['refactor the parser', 'then add tests'])
    expect(await rows(f)).not.toContainEqual({ kind: 'status', text: MOVED_NOTE })
  } finally {
    await f.dispose()
  }
})

it('a Claude account switch leaves a Codex chat on its account', async () => {
  let selected = '/homes/a'
  const home = () => ({ variable: 'CODEX_HOME', path: selected })
  const rig = await createRestTestRig({ launchAccountHome: async () => home() })
  try {
    const start = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementation(async (input) => ({
      ...(await start(input)),
      accountHome: home()
    }))
    await foundRestTestChat(rig)
    selected = '/homes/b'
    await moveStructuredAgentSessionChatsToSelectedAccount(rig.host, () => true)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    expect(rig.host.childAccountHome(HOST_TEST_SESSION)).toEqual({
      variable: 'CODEX_HOME',
      path: '/homes/a'
    })
  } finally {
    await rig.dispose()
  }
})
