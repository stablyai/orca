import { afterEach, expect, it, vi } from 'vitest'
import { encodeOmpRewindTarget } from '../../shared/omp-rewind-target'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { structuredRewindCut } from '../native-chat/agent-session-wire/structured-rewind-cut'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { PiRpcConnection } from '../pi/rpc-session'
import type { PiSessionEntry } from '../pi/rpc-history-import'
import { file, state } from '../pi/rpc-session-adapter.test-fixture'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'
import { supportsOmpRewind } from './rpc-rewind'

afterEach(closeOmpRpcAdapterFixtures)
const input = { sessionId: 'omp-test', fence: 1 }
const user = (id: string, parentId: string | null, timestamp: number) => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'user', content: 'identical', timestamp }
})
const entries = [
  user('u1', null, 100),
  { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant' } },
  { type: 'message', id: 'tool1', parentId: 'a1', message: { role: 'toolResult' } },
  user('u2', 'tool1', 200),
  { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant' } }
]

async function setup() {
  const h = await setupOmpRpcAdapter()
  let leafId: string | null = 'a2'
  let currentEntries: PiSessionEntry[] = [...entries]
  let busy = false
  let goal: { goal: { status: string } } | null = null
  const rpc: PiRpcConnection = h.connection
  const original = rpc.request.bind(rpc)
  const navigate = vi.fn(async (params?: Record<string, unknown>) => {
    const target = currentEntries.find((row) => row.id === params?.entryId)
    if (!target) {
      throw new Error('Unknown fixture target')
    }
    leafId = target.parentId
    return { cancelled: false }
  })
  vi.spyOn(rpc, 'request').mockImplementation(async (command, params, options) => {
    if (command === 'get_entries') {
      return { entries: currentEntries, leafId }
    }
    if (command === 'get_state') {
      return {
        ...state,
        isSettled: !busy,
        queuedMessageCount: 0,
        goal
      }
    }
    if (command === 'navigate_tree') {
      return navigate(params)
    }
    return original(command, params, options)
  })
  return {
    ...h,
    navigate,
    setLeaf: (leaf: string | null) => {
      leafId = leaf
    },
    setEntries: (rows: PiSessionEntry[]) => {
      currentEntries = rows
    },
    setBusy: () => {
      busy = true
    },
    setGoal: () => {
      goal = { goal: { status: 'active' } }
    }
  }
}

it('detects native navigation without changing the leaf, and declines older RPC versions', async () => {
  const request = vi.fn<PiRpcConnection['request']>()
  request
    .mockRejectedValueOnce(new JsonlRpcResponseError('navigate_tree', 'entryId must be a string'))
    .mockRejectedValueOnce(
      new JsonlRpcResponseError('navigate_tree', 'Unknown command: navigate_tree')
    )
    .mockRejectedValueOnce(new Error('disconnected'))
  await expect(supportsOmpRewind({ request })).resolves.toBe(true)
  await expect(supportsOmpRewind({ request })).resolves.toBe(false)
  await expect(supportsOmpRewind({ request })).resolves.toBe(false)
  expect(request.mock.calls.every(([, params]) => params?.entryId === null)).toBe(true)
})

it('rewinds identical prompts by native identity, retaining the whole earlier tool batch', async () => {
  const h = await setup()
  const beforeTurnId = encodeOmpRewindTarget({ sessionFile: file, timestamp: 200 })
  await expect(h.adapter.rewind({ ...input, beforeTurnId })).resolves.toEqual({ ok: true })
  expect(h.navigate).toHaveBeenCalledWith({ entryId: 'u2', summarize: false })
  await expect(
    h.adapter.recoverRewind({ ...input, beforeTurnId, keptTurnId: null })
  ).resolves.toEqual({ ok: true })
  expect(h.navigate).toHaveBeenCalledTimes(1)
})

it('rewinds the first prompt to the root and confirms it without replaying navigation', async () => {
  const h = await setup()
  const beforeTurnId = encodeOmpRewindTarget({ entryId: 'u1' })
  await expect(h.adapter.rewind({ ...input, beforeTurnId })).resolves.toEqual({ ok: true })
  await expect(
    h.adapter.recoverRewind({ ...input, beforeTurnId, keptTurnId: null })
  ).resolves.toEqual({ ok: true })
  expect(h.navigate).toHaveBeenCalledTimes(1)
})

it('preserves the chat when an extension vetoes navigation', async () => {
  const h = await setup()
  h.navigate.mockResolvedValueOnce({ cancelled: true })
  const beforeTurnId = encodeOmpRewindTarget({ entryId: 'u2' })
  await expect(h.adapter.rewind({ ...input, beforeTurnId })).resolves.toEqual({
    ok: false,
    reason: 'provider-refused'
  })
  await expect(
    h.adapter.recoverRewind({ ...input, beforeTurnId, keptTurnId: null })
  ).resolves.toEqual({ ok: false, reason: 'provider-refused' })
})

it('recovers a lost reply from the native parent leaf without a second navigation', async () => {
  const h = await setup()
  h.navigate.mockImplementationOnce(async () => {
    h.setLeaf('tool1')
    throw new Error('lost reply')
  })
  const beforeTurnId = encodeOmpRewindTarget({ entryId: 'u2' })
  await expect(h.adapter.rewind({ ...input, beforeTurnId })).rejects.toThrow('lost reply')
  await expect(
    h.adapter.recoverRewind({ ...input, beforeTurnId, keptTurnId: null })
  ).resolves.toEqual({ ok: true })
  h.setLeaf('a1')
  await expect(
    h.adapter.recoverRewind({ ...input, beforeTurnId, keptTurnId: null })
  ).resolves.toEqual({ ok: false, reason: 'outcome-unknown' })
  expect(h.navigate).toHaveBeenCalledTimes(1)
})

it('observes the native leaf when a hook reports an error after committing navigation', async () => {
  const h = await setup()
  h.navigate.mockImplementationOnce(async () => {
    h.setLeaf('tool1')
    throw new JsonlRpcResponseError('navigate_tree', 'Extension failed after navigation')
  })
  await expect(
    h.adapter.rewind({ ...input, beforeTurnId: encodeOmpRewindTarget({ entryId: 'u2' }) })
  ).resolves.toEqual({ ok: true })
})

it('rewinds a user-invoked Skill while excluding agent-injected custom messages', async () => {
  const h = await setup()
  const skill = {
    type: 'custom_message',
    id: 'skill',
    parentId: 'a2',
    customType: 'skill-prompt',
    attribution: 'user',
    timestamp: new Date(300).toISOString()
  }
  h.setEntries([...entries, { ...skill, id: 'injection', attribution: 'agent' }, skill])
  h.setLeaf('skill')
  await expect(
    h.adapter.rewind({
      ...input,
      beforeTurnId: encodeOmpRewindTarget({ sessionFile: file, timestamp: 300 })
    })
  ).resolves.toEqual({ ok: true })
  expect(h.navigate).toHaveBeenCalledWith({ entryId: 'skill', summarize: false })
})

it('refuses ambiguous, foreign, off-branch and non-user targets without mutation', async () => {
  const h = await setup()
  for (const target of [
    { entryId: 'missing' },
    { entryId: 'tool1' },
    { sessionFile: '/other.jsonl', timestamp: 200 }
  ]) {
    await expect(
      h.adapter.rewind({ ...input, beforeTurnId: encodeOmpRewindTarget(target) })
    ).resolves.toEqual({ ok: false, reason: 'invalid-target' })
  }
  h.setLeaf('tool1')
  await expect(
    h.adapter.rewind({ ...input, beforeTurnId: encodeOmpRewindTarget({ entryId: 'u2' }) })
  ).resolves.toEqual({ ok: false, reason: 'invalid-target' })
  h.setEntries([...entries, user('collision', 'a2', 200)])
  await expect(
    h.adapter.rewind({
      ...input,
      beforeTurnId: encodeOmpRewindTarget({ sessionFile: file, timestamp: 200 })
    })
  ).resolves.toEqual({ ok: false, reason: 'invalid-target' })
  expect(h.navigate).not.toHaveBeenCalled()
})

it.each(['work', 'goal', 'historical-goal'] as const)(
  'refuses navigation while native %s can continue executing',
  async (kind) => {
    const h = await setup()
    if (kind === 'work') {
      h.setBusy()
    } else if (kind === 'goal') {
      h.setGoal()
    } else {
      h.setEntries([
        { type: 'mode_change', id: 'goal', parentId: null, mode: 'goal' },
        ...entries.map((row) => (row.id === 'u1' ? { ...row, parentId: 'goal' } : row)),
        { type: 'mode_change', id: 'exited-goal', parentId: 'a2', mode: 'chat' }
      ])
      h.setLeaf('exited-goal')
    }
    await expect(
      h.adapter.rewind({ ...input, beforeTurnId: encodeOmpRewindTarget({ entryId: 'u2' }) })
    ).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(h.navigate).not.toHaveBeenCalled()
  }
)

it('persists the opener marker through settlement and restart, without replacing it with steering', async () => {
  const h = await setup()
  await h.rig.journal.appendItem(
    { provider: 'orca', clientMessageId: 'send' },
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'identical' }]
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await h.adapter.dispatch({
    ...input,
    clientMessageId: 'send',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'identical' }]
    }
  })
  h.connection.receive({ type: 'agent_start' })
  h.connection.receive({
    type: 'message_end',
    message: { role: 'user', content: 'identical', timestamp: 100 }
  })
  h.connection.receive({
    type: 'message_end',
    message: { role: 'user', content: 'steering', timestamp: 200 }
  })
  h.connection.receive({ type: 'agent_settled' })
  await vi.waitFor(async () => {
    const turn = (await h.rig.rows()).find((row) => row.body.kind === 'turn')?.body
    expect(turn).toMatchObject({
      state: 'completed',
      providerTurnId: encodeOmpRewindTarget({ sessionFile: file, timestamp: 100 })
    })
  })
  const journal = await h.rig.reopenJournal()
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalSubmissionKey('send'),
    provider: 'omp',
    nativeId: file
  })
  expect(cut).toMatchObject({
    beforeTurnId: encodeOmpRewindTarget({ sessionFile: file, timestamp: 100 })
  })
  expect(cut?.kept.some((row) => row.body.kind === 'turn' || row.body.kind === 'message')).toBe(
    false
  )
})
