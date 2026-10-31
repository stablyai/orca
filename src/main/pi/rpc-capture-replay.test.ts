import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from './rpc-turns'
import { PiRpcOptionObservations, readPiRpcSessionOptions } from './rpc-options'
import { piRpcStateSchema } from './rpc-protocol'
import { piRpcFailureFact } from './rpc-prompt-delivery'
import { agentSessionFailureSentence } from '../../shared/agent-session-failure-words'
import { piRpcDialogPresentation } from './rpc-extension-dialogs'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

const envelope = z.object({ dir: z.enum(['in', 'out']), raw: z.string() })
const record = z.looseObject({ type: z.string() })
function capture(name: string) {
  return readFileSync(join(import.meta.dirname, '__fixtures__', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = envelope.parse(JSON.parse(line))
      return { dir: parsed.dir, frame: record.parse(JSON.parse(parsed.raw)) }
    })
}
const disposals: (() => void)[] = []

it('separates resend advice from the captured Pi 1.0.4 missing-key detail', () => {
  const reply = capture('signed-out').find(
    ({ dir, frame }) => dir === 'out' && frame.command === 'prompt' && frame.success === false
  )?.frame
  if (typeof reply?.error !== 'string') {
    throw new Error('The signed-out capture must contain a prompt error')
  }
  expect(reply.error.endsWith('docs/models.md')).toBe(true)
  const fact = piRpcFailureFact(reply.error)
  expect(fact.kind).toBe('notSignedIn')
  expect(fact.detail?.text).toBe(reply.error)
  expect(agentSessionFailureSentence(fact, 'rejection', { agentName: 'Pi' })).toContain(
    `${reply.error}. Then send your message again.`
  )
})

afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

async function replay(
  name: string,
  oversized: (frame: z.infer<typeof record>) => boolean = () => false
) {
  const frames = capture(name)
  const states = frames.filter(
    ({ dir, frame }) => dir === 'out' && frame.type === 'response' && frame.command === 'get_state'
  )
  const stats = frames.findLast(
    ({ dir, frame }) =>
      dir === 'out' && frame.type === 'response' && frame.command === 'get_session_stats'
  )?.frame.data
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId: 'session-timeline' })
  const accepted = vi.fn(),
    failed = vi.fn(),
    idle = vi.fn(),
    settled = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: 'session-timeline',
    agent: 'pi',
    generation: 'gen-pi',
    namespace: 'pi-session',
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
    onInputAccepted: accepted,
    onFailed: failed
  })
  const turns = new PiRpcTurns({
    lane,
    generation: 'gen-pi',
    send: vi.fn(async () => {}),
    request: vi.fn(async (command: string) =>
      command === 'get_state' ? states.at(-1)?.frame.data : stats
    ),
    settled,
    failed,
    idle
  })
  disposals.push(() => {
    turns.end()
    lane.dispose()
  })
  let sequence = 0
  for (const { dir, frame } of frames) {
    if (dir === 'in' && frame.type === 'prompt') {
      await turns.submit(`send-${++sequence}`, 100, frame)
    }
    if (dir === 'in' && frame.type === 'abort') {
      turns.stop()
    }
    if (dir === 'out' && oversized(frame)) {
      turns.skipped(frame.type, JSON.stringify(frame).slice(0, 256))
    } else if (dir === 'out' && (frame.type !== 'response' || frame.command === 'prompt')) {
      turns.receive(frame)
    }
    if (dir === 'out' && frame.type === 'response' && frame.command === 'get_state') {
      // The idle probe resolved here in the captured run.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  lane.flush()
  const rows = await rig.rows()
  return { rows, turns: await rig.turns(), accepted, failed, idle, settled }
}

function transcript(rows: Awaited<ReturnType<typeof replay>>['rows']): string {
  return rows
    .flatMap((row) =>
      row.body.kind === 'message'
        ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
}

describe('scrubbed Pi 1.0.4 RPC captures', () => {
  it('keeps captured current reports provisional until the native model listing arrives', async () => {
    const frames = capture('command-only')
    const response = (command: string) =>
      frames.find(({ dir, frame }) => dir === 'out' && frame.command === command)?.frame.data
    const observed = new PiRpcOptionObservations(
      { current: new Map(), writes: new Map() },
      () => true
    )
    const state = piRpcStateSchema.parse(response('get_state'))
    observed.seed(state)
    observed.prepareState(vi.fn())(state)
    expect(observed.read()).toMatchObject({
      models: [],
      modelsKnown: false,
      current: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' }
    })
    const adopt = observed.prepare()
    expect(
      adopt(await readPiRpcSessionOptions({ request: async (command) => response(command) }))
    ).toBe(true)
    expect(observed.read().modelsKnown).toBeUndefined()
    expect(observed.read().models).toContainEqual(
      expect.objectContaining({
        id: 'openai-codex/gpt-6.1-sol',
        label: 'GPT-6.1 Sol'
      })
    )
  })

  it('records tool output, streamed text, and all three consumed inputs in one settled run', async () => {
    const result = await replay('steer-followup')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1', 'send-2', 'send-3'])
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.outcome).toBe('success')
    expect(
      result.rows.some((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
    ).toBe(true)
    expect(transcript(result.rows)).toContain('STEER_CONSUMED')
    expect(transcript(result.rows)).toContain('FOLLOWUP_CONSUMED')
  })
  it('keeps the run and consumed inputs when Pi sends records too large to deliver', async () => {
    const result = await replay('steer-followup', (frame) =>
      ['tool_execution_end', 'message_end', 'turn_end', 'agent_end'].includes(frame.type)
    )
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1', 'send-2', 'send-3'])
    expect(result.turns.map((turn) => turn.outcome)).toEqual(['success'])
    expect(
      result.rows.filter((row) => row.body.kind === 'status' && row.body.tone === 'warning')
    ).toHaveLength(1)
    expect(result.rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      name: 'bash',
      state: 'completed'
    })
    expect(transcript(result.rows)).toContain('FOLLOWUP_CONSUMED')
  })
  it.each(['provider-fetch-error', 'provider-socket-error'])(
    'marks captured %s as failure with the provider diagnostic',
    async (name) => {
      const result = await replay(name)
      expect(result.failed).not.toHaveBeenCalled()
      expect(result.turns[0]?.outcome).toBe('failure')
      expect(
        result.rows.filter(
          (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerRejected'
        )
      ).toHaveLength(1)
    }
  )
  it('treats the captured abort error as cancellation', async () => {
    const result = await replay('stop-mid-tool')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.turns[0]?.outcome).toBe('cancellation')
    expect(result.rows.some((row) => row.body.kind === 'status' && row.body.failure)).toBe(false)
  })
  it('settles a handled extension command with no agent events', async () => {
    const result = await replay('command-only')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.turns[0]?.outcome).toBe('success')
    expect(result.accepted).toHaveBeenCalledWith('send-1')
  })
  it('tracks the run a captured Pi 1.3.0 subagent wake starts on the idle parent', async () => {
    const result = await replay('subagent-wake')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1'])
    expect(result.turns.map((turn) => turn.outcome)).toEqual(['success', 'success'])
    expect(result.idle).toHaveBeenCalledTimes(2)
    expect(transcript(result.rows)).toContain('WAKE_CONSUMED')
  })
  it('preserves empty answers and literal Unicode separators in captured dialogs', () => {
    const dialogs = capture('dialogs').flatMap(({ dir, frame }) =>
      dir === 'out' && frame.type === 'extension_ui_request' ? [frame] : []
    )
    const input = piRpcDialogPresentation(dialogs.find((frame) => frame.method === 'input'))
    const editor = piRpcDialogPresentation(dialogs.find((frame) => frame.method === 'editor'))
    expect(
      input?.reply({
        kind: 'answers',
        answers: [{ questionId: String(input.id), optionIds: [], other: '' }]
      })
    ).toEqual({ value: '' })
    const body = editor?.body
    expect(body?.kind === 'question' && body.freeTextInput?.initialValue).toContain('\n')
    expect(
      editor?.reply({
        kind: 'answers',
        answers: [
          { questionId: String(editor.id), optionIds: [], other: 'first\u2028second\u2029last' }
        ]
      })
    ).toEqual({ value: 'first\u2028second\u2029last' })
  })
})
