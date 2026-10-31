import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION,
  AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION
} from '../../../shared/agent-session-account-switch-row'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  StructuredAgentSessionAccountMoveError,
  type StructuredAgentSessionAccountFollow,
  type StructuredAgentSessionAccountMove
} from './structured-agent-session-account-follow'
import { retireOutgrownStructuredAgentSessionChild } from './structured-agent-session-outgrown-child'

const HOME_A: AgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/home/dev/.codex' }
const HOME_B: AgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/homes/b' }

function pickerFollow(initial: AgentSessionAccountHome) {
  const picker: { home: AgentSessionAccountHome; account?: string } = { home: initial }
  const move = vi.fn(
    async (record: AgentSessionRecord): Promise<StructuredAgentSessionAccountMove | null> =>
      record.accountHome === picker.home
        ? null
        : { accountHome: picker.home, ...(picker.account ? { account: picker.account } : {}) }
  )
  const follow: StructuredAgentSessionAccountFollow = {
    selectedHome: async () => picker.home,
    move
  }
  return { picker, move, follow }
}

describe('a chat after the account picker changed', () => {
  let rig: RestTestRig
  let picker: ReturnType<typeof pickerFollow>

  beforeEach(async () => {
    picker = pickerFollow(HOME_A)
    rig = await createRestTestRig({ accountFollow: picker.follow })
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const failedRows = () =>
    rig.host
      .collaboratorsForTests()
      .sessions.get(SESSION)
      ?.journal.snapshot()
      .items.filter(
        (item) =>
          item.body.kind === 'status' &&
          item.body.presentation === AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION
      ) ?? []
  const switchRows = () =>
    rig.host
      .collaboratorsForTests()
      .sessions.get(SESSION)
      ?.journal.snapshot()
      .items.filter(
        (item) =>
          item.body.kind === 'status' &&
          item.body.presentation === AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION
      ) ?? []

  it('continues on the selected account at its next send, with one quiet row', async () => {
    await foundRestTestChat(rig)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(HOME_A)

    picker.picker.home = HOME_B
    picker.picker.account = 'b@example.com'
    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))

    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire.mock.calls[1]?.[0].launch?.accountHome).toEqual(HOME_B)
    expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(HOME_B)
    const rows = switchRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toMatchObject({
      text: 'Now on b@example.com · same conversation',
      accountSwitch: { account: 'b@example.com' }
    })

    // The new agent is kept: the record now names the selected account.
    expect((await rig.host.send(CALLER, restTestSend('again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(switchRows()).toHaveLength(1)
  })

  it('quietly repins a chat whose saved account may not be where it ran', async () => {
    await foundRestTestChat(rig)
    picker.picker.home = HOME_B
    picker.move.mockImplementation(async () => ({ accountHome: HOME_B, quiet: true }))
    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))

    expect(rig.adapter.acquire.mock.calls[1]?.[0].launch?.accountHome).toEqual(HOME_B)
    expect(rig.store.getRecord(SESSION)).toMatchObject({
      accountHome: HOME_B,
      accountHomeConfirmed: true
    })
    expect(switchRows()).toHaveLength(0)
  })

  it('stays on its account when the conversation cannot be carried', async () => {
    await foundRestTestChat(rig)
    picker.picker.home = HOME_B
    picker.move.mockImplementation(async () => {
      throw new Error('rollout unreadable')
    })
    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))

    expect(rig.adapter.acquire.mock.calls[1]?.[0].launch?.accountHome).toEqual(HOME_A)
    expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(HOME_A)
    expect(switchRows()).toHaveLength(0)
    // Nothing named the accounts, so there is nothing to tell the reader.
    expect(failedRows()).toHaveLength(0)
  })

  it('says so in the chat when the conversation could not be carried', async () => {
    await foundRestTestChat(rig)
    picker.picker.home = HOME_B
    picker.move.mockImplementation(async () => {
      throw new StructuredAgentSessionAccountMoveError(
        { account: 'b@example.com', from: 'a@example.com' },
        { cause: new Error('EBUSY') }
      )
    })
    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))

    expect(rig.adapter.acquire.mock.calls[1]?.[0].launch?.accountHome).toEqual(HOME_A)
    expect(failedRows().map((row) => row.body)).toEqual([
      expect.objectContaining({
        text: "Couldn't move this chat to b@example.com; it's still on a@example.com",
        accountSwitch: { account: 'b@example.com', from: 'a@example.com' }
      })
    ])
    // One attempt per selection: the next send neither retries nor repeats the line.
    expect((await rig.host.send(CALLER, restTestSend('again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(failedRows()).toHaveLength(1)

    // A restart forgets the attempt and tries again, but the chat already says so.
    await rig.restart({ accountFollow: picker.follow })
    expect((await rig.host.send(CALLER, restTestSend('after restart', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(picker.move).toHaveBeenCalledTimes(2)
    expect(failedRows()).toHaveLength(1)

    // A different account is news, so it gets its own line.
    picker.move.mockImplementation(async () => {
      throw new StructuredAgentSessionAccountMoveError(
        { account: 'c@example.com', from: 'a@example.com' },
        { cause: new Error('EBUSY') }
      )
    })
    picker.picker.home = { variable: 'CODEX_HOME', path: '/homes/c' }
    expect((await rig.host.send(CALLER, restTestSend('third', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(failedRows()).toHaveLength(2))
  })
})

describe('retireOutgrownStructuredAgentSessionChild on an account switch', () => {
  type Work = Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2]['work']
  const quiet: Work = {
    currentWork: () => ({ activeTurnId: () => null, hasActionablePrompt: () => false }),
    childWork: () => [],
    childWorkOpen: () => false,
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false
  }
  const session = {
    child: { generation: 'generation-1', fence: 1, phase: 'ready' as const },
    journal: {
      submissions: () => [],
      visitItemsWithLinkage: () => undefined,
      itemFence: () => undefined,
      itemBody: () => null,
      newestTurn: () => null
    }
  }
  const retire = async (work: Partial<Work>, moved: boolean) => {
    const stopAgent = vi.fn(async () => undefined)
    await retireOutgrownStructuredAgentSessionChild('session', session, {
      work: { ...quiet, ...work },
      launchedOnOtherAccount: async () => moved,
      stopAgent,
      logger: { warn: vi.fn(), error: vi.fn() }
    })
    return stopAgent
  }

  it('replaces a quiet child launched on another account', async () => {
    expect(await retire({}, true)).toHaveBeenCalledWith('session')
    expect(await retire({}, false)).not.toHaveBeenCalled()
  })

  it('lets a busy chat finish its turn first', async () => {
    const busyWork: Partial<Work>[] = [
      { currentWork: () => ({ activeTurnId: () => 'turn-1', hasActionablePrompt: () => false }) },
      { currentWork: () => ({ activeTurnId: () => null, hasActionablePrompt: () => true }) },
      { childWorkOpen: () => true },
      { hasOpenDispatch: () => true }
    ]
    for (const busy of busyWork) {
      expect(await retire(busy, true)).not.toHaveBeenCalled()
    }
  })
})
