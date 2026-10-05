import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatAsyncQuestionsField } from '../../shared/native-chat-async-questions'
import type { AgentType } from '../../shared/native-chat-types'
import { subscribeNativeChatTranscript } from './transcript-watch'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

let tempRoots: string[] = []
let subscriptions: NativeChatTranscriptSubscription[] = []

afterEach(async () => {
  for (const subscription of subscriptions) {
    subscription.unsubscribe()
  }
  subscriptions = []
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

type Question = { title: string; options?: string[] }

const line = (record: unknown): string => `${JSON.stringify(record)}\n`
const userEvent = (text = 'prompt'): string =>
  line({ type: 'event_msg', payload: { type: 'user_message', message: text } })
const userItem = (id: string, text = 'prompt'): string =>
  line({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', id, content: [{ type: 'text', text }] }
    }
  })
const contextRecord = (): string =>
  line({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }]
    }
  })
const asyncCall = (callId: string, questions: Question[]): string =>
  line({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: callId,
      arguments: JSON.stringify({ questions })
    }
  })
const callOutput = (callId: string): string =>
  line({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' }
  })
const legacyAsk = (questions: Question[]): string =>
  line({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: questions.map((question) => question.title).join('\n\n'),
      delivery: 'async',
      questions
    }
  })
const itemAsk = (callId: string, questions: Question[]): string =>
  line({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: callId,
        content: [{ type: 'Text', text: questions.map((question) => question.title).join('\n') }],
        delivery: 'async',
        questions
      }
    }
  })
const assistant = (index: number): string =>
  line({ type: 'event_msg', payload: { type: 'agent_message', message: `work ${index}` } })
const toolOutput = (bytes: number): string =>
  line({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'shell', output: 'x'.repeat(bytes) }
  })

async function rollout(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-async-questions-'))
  tempRoots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, content)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Observed = {
  frames: { kind: 'snapshot' | 'replacement' | 'appended'; field?: NativeChatAsyncQuestionsField }[]
  latest: () => NativeChatAsyncQuestionsField | undefined
  ready: () => Extract<NativeChatAsyncQuestionsField, { state: 'ready' }> | undefined
}

async function watch(
  filePath: string,
  agent: AgentType = 'codex',
  initialLimit = 40
): Promise<Observed> {
  const frames: Observed['frames'] = []
  const subscription = await subscribeNativeChatTranscript({
    agent,
    sessionId: 'session',
    filePath,
    initialLimit,
    debounceMs: 5,
    onInitialSnapshot: (_messages, _hasMore, _before, _error, _lifecycle, asyncQuestions) =>
      frames.push({ kind: 'snapshot', field: asyncQuestions }),
    onReplace: (_messages, _hasMore, _before, _lifecycle, asyncQuestions) =>
      frames.push({ kind: 'replacement', field: asyncQuestions }),
    onAppend: (_messages, _lifecycle, asyncQuestions) =>
      frames.push({ kind: 'appended', field: asyncQuestions })
  })
  subscriptions.push(subscription)
  const latest = (): NativeChatAsyncQuestionsField | undefined =>
    frames.findLast((frame) => frame.field !== undefined)?.field
  return {
    frames,
    latest,
    ready: () => {
      const field = latest()
      return field?.state === 'ready' ? field : undefined
    }
  }
}

function keyIdentity(key: string): unknown {
  const parsed: unknown = JSON.parse(key)
  return Array.isArray(parsed) ? parsed[1] : undefined
}

const titles = (observed: Observed): string[] =>
  observed.ready()?.questions.map((question) => question.title) ?? []
const keys = (observed: Observed): string[] =>
  observed.ready()?.questions.map((question) => question.key) ?? []

describe('host-derived Codex async questions on the terminal transport', () => {
  it('carries a question asked before far more than the subscribe window', async () => {
    const color = [{ title: 'Which color?', options: ['Red', 'Blue'] }]
    let content = userEvent() + asyncCall('call-1', color) + itemAsk('call-1', color)
    content += callOutput('call-1')
    for (let index = 0; index < 200; index += 1) {
      content += assistant(index)
    }
    const observed = await watch(await rollout(content), 'codex', 40)
    await waitFor(() => observed.ready() !== undefined)
    expect(observed.frames[0]).toMatchObject({ kind: 'snapshot', field: { state: 'pending' } })
    expect(observed.ready()?.questions).toEqual([
      {
        key: JSON.stringify(['request_user_input_async', 'call-1', 0]),
        providerItemId: 'call-1',
        index: 0,
        title: 'Which color?',
        options: ['Red', 'Blue']
      }
    ])
  })

  it('gives a live and a fresh subscriber the same set after more than 16 MiB of output', async () => {
    const ask = [{ title: 'Ship it?' }]
    const filePath = await rollout(userEvent() + asyncCall('call-a', ask) + itemAsk('call-a', ask))
    const live = await watch(filePath)
    await waitFor(() => live.ready()?.questions.length === 1)
    for (let chunk = 0; chunk < 17; chunk += 1) {
      await appendFile(filePath, toolOutput(1024 * 1024))
    }
    const fresh = await watch(filePath)
    await waitFor(() => fresh.ready() !== undefined, 30_000)
    expect(keys(fresh)).toEqual(keys(live))
    expect(titles(fresh)).toEqual(['Ship it?'])
  }, 60_000)

  it('lets a reconnect to an unchanged file carry ready on its snapshot, with no pending blink', async () => {
    const ask = [{ title: 'Ship it?' }]
    let content = userEvent() + asyncCall('call-a', ask) + itemAsk('call-a', ask)
    for (let index = 0; index < 60; index += 1) {
      content += assistant(index)
    }
    const filePath = await rollout(content)
    const first = await watch(filePath)
    await waitFor(() => first.ready()?.questions.length === 1)
    // The live subscription's drains share its fold once the read is settled.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const reconnected = await watch(filePath)
    await waitFor(() => reconnected.frames.length > 0)
    expect(reconnected.frames[0]).toMatchObject({ kind: 'snapshot', field: { state: 'ready' } })
    expect(titles(reconnected)).toEqual(['Ship it?'])
  })

  it('retires the set on a delivered user message and publishes [] on appended', async () => {
    const ask = [{ title: 'Name?' }]
    const filePath = await rollout(userEvent() + asyncCall('c', ask) + itemAsk('c', ask))
    const observed = await watch(filePath)
    await waitFor(() => observed.ready()?.questions.length === 1)
    await appendFile(filePath, userEvent('Question: Name?\nAnswer: Orca'))
    await waitFor(() => observed.ready()?.questions.length === 0)
    expect(observed.frames.at(-1)).toMatchObject({ kind: 'appended', field: { state: 'ready' } })
  })

  it('stops the backward scan at a user reply too large to read', async () => {
    const ask = [{ title: 'Name?' }]
    const huge = 'y'.repeat(3 * 1024 * 1024)
    const filePath = await rollout(
      userEvent() + asyncCall('c', ask) + itemAsk('c', ask) + userEvent(huge) + assistant(1)
    )
    const observed = await watch(filePath)
    await waitFor(() => observed.ready() !== undefined)
    expect(titles(observed)).toEqual([])
  })

  it('retires the set when a user reply too large to read is appended', async () => {
    const ask = [{ title: 'Name?' }]
    const filePath = await rollout(userEvent() + asyncCall('c', ask) + itemAsk('c', ask))
    const observed = await watch(filePath)
    await waitFor(() => observed.ready()?.questions.length === 1)
    await appendFile(filePath, userEvent('y'.repeat(3 * 1024 * 1024)) + assistant(1))
    await waitFor(() => observed.ready()?.questions.length === 0)
  })

  it('omits the field on appended frames when the set did not change', async () => {
    const ask = [{ title: 'Name?' }]
    const filePath = await rollout(userEvent() + asyncCall('c', ask) + itemAsk('c', ask))
    const observed = await watch(filePath)
    await waitFor(() => observed.ready()?.questions.length === 1)
    const before = observed.frames.length
    await appendFile(filePath, assistant(1))
    await waitFor(() => observed.frames.length > before)
    expect(observed.frames.slice(before).every((frame) => frame.field === undefined)).toBe(true)
  })

  it('does not treat injected context records as delivered user messages', async () => {
    const ask = [{ title: 'Name?' }]
    const filePath = await rollout(userEvent() + asyncCall('c', ask) + itemAsk('c', ask))
    const observed = await watch(filePath)
    await waitFor(() => observed.ready()?.questions.length === 1)
    await appendFile(filePath, contextRecord() + assistant(2))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(titles(observed)).toEqual(['Name?'])
  })

  it('keeps a question across the acknowledgement, turn end and interrupt', async () => {
    const ask = [{ title: 'Keep?' }]
    const interrupt = line({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't' } })
    const done = line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } })
    const content =
      userEvent() + asyncCall('c', ask) + itemAsk('c', ask) + callOutput('c') + done + interrupt
    const observed = await watch(await rollout(content))
    await waitFor(() => observed.ready() !== undefined)
    expect(titles(observed)).toEqual(['Keep?'])
  })

  it('publishes nothing for a non-Codex agent', async () => {
    const content = line({
      type: 'user',
      uuid: 'u',
      message: { role: 'user', content: 'hi' }
    })
    const observed = await watch(await rollout(content), 'claude')
    await waitFor(() => observed.frames.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(observed.frames.every((frame) => frame.field === undefined)).toBe(true)
  })

  it('folds legacy-mode messages by a proven call, else by record position', async () => {
    const red = [{ title: 'Color?', options: ['Red'] }]
    const size = [{ title: 'Size?' }]
    const same = [{ title: 'Same?' }]
    // Two calls recorded before either message (parallel tools), then two identical calls.
    const content =
      userEvent() +
      asyncCall('call-red', red) +
      asyncCall('call-size', size) +
      legacyAsk(size) +
      legacyAsk(red) +
      asyncCall('call-s1', same) +
      asyncCall('call-s2', same) +
      legacyAsk(same) +
      legacyAsk(same)
    const filePath = await rollout(content)
    const observed = await watch(filePath)
    await waitFor(() => observed.ready() !== undefined)
    const identities = observed.ready()?.questions.map((question) => keyIdentity(question.key))
    expect(titles(observed)).toEqual(['Size?', 'Color?', 'Same?', 'Same?'])
    expect(identities?.slice(0, 2)).toEqual(['call-size', 'call-red'])
    // Ambiguous content stays keyed by its own (distinct) record position.
    expect(String(identities?.[2])).toContain(filePath)
    expect(String(identities?.[3])).toContain(filePath)
    expect(identities?.[2]).not.toBe(identities?.[3])

    // A reconnect (fresh subscription) and a resume that appends new records keep the keys.
    const before = keys(observed)
    await appendFile(filePath, assistant(3))
    const reconnected = await watch(filePath)
    await waitFor(() => reconnected.ready() !== undefined)
    expect(keys(reconnected)).toEqual(before)
  })

  it('keeps one entry when the item form follows a legacy record of the same call', async () => {
    const ask = [{ title: 'Once?' }]
    const content = userEvent() + asyncCall('call-1', ask) + legacyAsk(ask) + itemAsk('call-1', ask)
    const observed = await watch(await rollout(content))
    await waitFor(() => observed.ready() !== undefined)
    expect(keys(observed)).toEqual([JSON.stringify(['request_user_input_async', 'call-1', 0])])
  })

  it("retires only the question Codex's own editor answered, scanning past the reply", async () => {
    const color = [{ title: 'Color?' }]
    const size = [{ title: 'Size?' }]
    const editorReply = (callId: string, title: string): string =>
      `<send_user_message_question_reply>\n${JSON.stringify([
        {
          answer: 'blue',
          question: title,
          questionItemId: JSON.stringify(['request_user_input_async', callId, 0])
        }
      ])}\n</send_user_message_question_reply>`
    const filePath = await rollout(
      userEvent() +
        asyncCall('call-a', color) +
        itemAsk('call-a', color) +
        asyncCall('call-b', size) +
        itemAsk('call-b', size) +
        userItem('u2', editorReply('call-a', 'Color?')) +
        assistant(1)
    )
    // Backward reconstruction keeps scanning past a reply to the prompt that clears all.
    const fresh = await watch(filePath)
    await waitFor(() => fresh.ready() !== undefined)
    expect(titles(fresh)).toEqual(['Size?'])
    // Appended: the live fold retires only what the reply names.
    await appendFile(filePath, asyncCall('call-c', color) + itemAsk('call-c', color))
    await waitFor(() => titles(fresh).length === 2)
    await appendFile(filePath, userEvent(editorReply('call-b', 'Size?')))
    await waitFor(() => titles(fresh).length === 1)
    expect(titles(fresh)).toEqual(['Color?'])
  })

  it('reads paginated-mode user items as the boundary', async () => {
    const old = [{ title: 'Old?' }]
    const fresh = [{ title: 'New?' }]
    const content =
      userItem('u1') +
      asyncCall('c-old', old) +
      itemAsk('c-old', old) +
      userItem('u2') +
      asyncCall('c-new', fresh) +
      itemAsk('c-new', fresh)
    const observed = await watch(await rollout(content))
    await waitFor(() => observed.ready() !== undefined)
    expect(titles(observed)).toEqual(['New?'])
  })

  it('folds appends that race the reconstruction after it, in file order', async () => {
    const ask = [{ title: 'First?' }]
    const later = [{ title: 'Later?' }]
    let content = userEvent() + asyncCall('c1', ask) + itemAsk('c1', ask)
    for (let chunk = 0; chunk < 8; chunk += 1) {
      content += toolOutput(1024 * 1024)
    }
    const filePath = await rollout(content)
    const observed = await watch(filePath)
    await waitFor(() => observed.frames.length > 0)
    await appendFile(filePath, asyncCall('c2', later) + itemAsk('c2', later))
    await waitFor(() => observed.ready()?.questions.length === 2, 30_000)
    expect(titles(observed)).toEqual(['First?', 'Later?'])
  }, 60_000)

  it('re-derives on replacement', async () => {
    const ask = [{ title: 'Before?' }]
    const filePath = await rollout(userEvent() + asyncCall('c', ask) + itemAsk('c', ask))
    const observed = await watch(filePath)
    await waitFor(() => observed.ready()?.questions.length === 1)
    const after = [{ title: 'After?' }]
    await writeFile(filePath, userEvent() + asyncCall('d', after) + itemAsk('d', after))
    await waitFor(() => titles(observed)[0] === 'After?')
    expect(observed.frames.some((frame) => frame.kind === 'replacement')).toBe(true)
  })

  it('publishes nothing more after unsubscribe', async () => {
    const ask = [{ title: 'Gone?' }]
    let content = userEvent() + asyncCall('c', ask) + itemAsk('c', ask)
    for (let chunk = 0; chunk < 4; chunk += 1) {
      content += toolOutput(1024 * 1024)
    }
    const observed = await watch(await rollout(content))
    await waitFor(() => observed.frames.length > 0)
    subscriptions.pop()?.unsubscribe()
    const count = observed.frames.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(observed.frames).toHaveLength(count)
  })
})
