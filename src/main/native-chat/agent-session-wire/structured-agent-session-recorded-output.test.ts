import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { readCodexThreadId } from '../../codex/codex-structured-thread-facts'
import { openAcpFixtureRig, readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { GROK_ACP_DIALECT } from '../../acp/acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from '../../acp/acp-dialects/opencode-dialect'
import { OMP_ACP_DIALECT } from '../../acp/acp-dialects/omp-dialect'
import { JsonlRpcPeer } from '../../jsonl-rpc/peer'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from '../../pi/rpc-turns'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION,
  type ProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})
const record = z.record(z.string(), z.unknown())
function recording(relative: string): unknown[] {
  return readFileSync(join(import.meta.dirname, relative), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function pressure(rig: ProviderTimelineRig): void {
  for (let index = 0; index < 1024; index++) {
    rig.eventSink.appendItem(
      { provider: 'orca', clientMessageId: `queued-${index}` },
      { kind: 'status', tone: 'info', text: `queued-${index}` },
      { lifecycle: true, turnScope: { kind: 'thread' } }
    )
  }
}

async function saved(rig: ProviderTimelineRig, expected?: unknown[]) {
  const rows = await rig.rows()
  if (expected) {
    expect(rows.length).toBeGreaterThan(1024)
  }
  expect(new Set(rows.map((row) => row.itemId)).size).toBe(rows.length)
  const reopened = await rig.reopenJournal()
  expect(reopened.snapshot().items).toEqual(rows)
  const content = reopened
    .snapshot()
    .items.filter((row) => !row.itemId.startsWith('orca:queued-'))
    .map((row) => ({ itemId: row.itemId, body: row.body, turnScope: row.turnScope }))
  if (expected) {
    expect(content).toEqual(expected)
  }
  return content
}

it('saves the recorded Claude batch-lead frames behind live lifecycle writes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(10_000))
  let expected: unknown[] | undefined
  for (const pressured of [false, true]) {
    const rig = await openProviderTimelineRig()
    const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
    if (pressured) {
      pressure(rig)
    }
    try {
      const shape = z.object({ kind: z.string(), at: z.number(), frame: record.optional() })
      for (const value of recording(
        '../../claude/__fixtures__/claude-lifecycle-capture-batch-lead.jsonl'
      )) {
        const frame = shape.parse(value)
        if (frame.kind === 'frame' && frame.frame) {
          translator.handle({
            type: 'message',
            sessionId: SESSION,
            message: frame.frame,
            observedAt: frame.at
          })
        }
      }
      translator.flush()
      const assistantFrames = recording(
        '../../claude/__fixtures__/claude-lifecycle-capture-batch-lead.jsonl'
      ).flatMap((value) => {
        const parsed = z
          .object({
            frame: z.object({
              type: z.literal('assistant'),
              message: z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
              })
            })
          })
          .safeParse(value)
        return parsed.success ? [parsed.data.frame.message.content] : []
      })
      const assistant = (await rig.rows()).filter(
        (row) => row.body.kind === 'message' && row.body.role === 'assistant'
      )
      expect(assistant.map((row) => row.itemId)).toEqual([
        'claude:00000000-0000-4000-8000-00000000c1a0:89d623dc-6a78-46fc-9123-ee06e2d61a6b',
        'claude:00000000-0000-4000-8000-00000000c1a0:63316a0d-face-40ab-b7c5-a2f3c7aef73b'
      ])
      expect(assistant.map((row) => row.body)).toEqual(
        assistantFrames.map((blocks) => ({ kind: 'message', role: 'assistant', blocks }))
      )
      expected = await saved(rig, expected)
    } finally {
      translator.dispose()
    }
  }
})

it('saves recorded Codex 0.158 control output in order behind live lifecycle writes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(10_000))
  let expected: unknown[] | undefined
  for (const pressured of [false, true]) {
    const rig = await openProviderTimelineRig()
    const shape = z.object({ case: z.string(), t: z.number(), method: z.string(), params: record })
    const frames = recording('../../codex/__fixtures__/codex-app-server-turn-endings.jsonl')
      .map((value) => shape.parse(value))
      .filter((frame) => frame.case === '0.158.0-control')
    const threadId = readCodexThreadId(frames[0]?.params)
    if (!threadId) {
      throw new Error('recorded primary thread missing')
    }
    const translator = createCodexJournalTranslator({
      sink: rig.eventSink,
      sessionId: SESSION,
      primaryThreadId: () => threadId
    })
    if (pressured) {
      pressure(rig)
    }
    try {
      for (const frame of frames) {
        expect(
          translator.handle({
            type: 'notification',
            sessionId: SESSION,
            threadId,
            method: frame.method,
            params: frame.params,
            observedAt: frame.t
          })
        ).toEqual({ accepted: true })
      }
      translator.flush()
      const rows = await rig.rows()
      expect(rows.some((row) => row.body.kind === 'turn' && row.body.state === 'completed')).toBe(
        true
      )
      expect(
        rows.filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
      ).toEqual([
        expect.objectContaining({
          itemId: `codex:${threadId}:00000000-0000-7000-8000-000000000051:1`,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'pong' }] }
        })
      ])
      expected = await saved(rig, expected)
    } finally {
      translator.dispose()
    }
  }
})

it.each([
  { name: 's1-basic', dialect: GROK_ACP_DIALECT },
  { name: 'opencode-v2-tool', dialect: OPENCODE_ACP_DIALECT },
  { name: 'omp-v17-shell-ok', dialect: OMP_ACP_DIALECT }
])('saves recorded $name output with unchanged journal identities', async ({ name, dialect }) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(10_000))
  let expected: unknown[] | undefined
  for (const pressured of [false, true]) {
    const fixture = await openAcpFixtureRig(dialect)
    const frames = await readAcpFixture(name)
    if (pressured) {
      pressure(fixture.rig)
    }
    await fixture.feed(frames)
    const tools = (await fixture.rig.rows()).flatMap((row) =>
      row.body.kind === 'tool-call' ? [row.body] : []
    )
    const outputs =
      name === 's1-basic'
        ? [
            {
              callId: 'call-1',
              output: JSON.stringify({
                type: 'ListDir',
                Content: {
                  content: '- /workspace/file-3\n  - math.js\n  - notes.txt\n  - README.md',
                  absolute_root_path: '/workspace/file-1'
                }
              })
            },
            {
              callId: 'call-2',
              output:
                '1→# Scratch project 1\n\nA tiny throwaway project used to record Grok ACP traffic.\n'
            }
          ]
        : name === 'opencode-v2-tool'
          ? [{ callId: 'call_54ffbe02d04b4842a2494b02', output: 'TOOL-OK\n' }]
          : [{ callId: 'call-1', output: 'ok' }]
    expect(tools).toEqual(
      outputs.map(({ callId, output }) =>
        expect.objectContaining({
          callId,
          state: 'completed',
          output: expect.objectContaining({
            head: output,
            truncated: false,
            byteLength: Buffer.byteLength(output)
          })
        })
      )
    )
    expected = await saved(fixture.rig, expected)
  }
})

it('transfers recorded Pi complete tool output from separate paused stdout chunks before close finalizes its lane', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(10_000))
  let expected: unknown[] | undefined
  for (const pressured of [false, true]) {
    const rig = await openProviderTimelineRig({ agent: 'pi' })
    const shape = z.object({ dir: z.enum(['in', 'out']), raw: z.string() })
    const frames = recording('../../pi/__fixtures__/stop-mid-tool.jsonl').map((value) =>
      shape.parse(value)
    )
    const lane = new JsonlRpcTimelineLane({
      sink: rig.sink,
      sessionId: SESSION,
      agent: 'pi',
      generation: 'pi-generation',
      namespace: 'pi-session',
      onInputAccepted: () => {},
      onFailed: (reason) => {
        throw new Error(reason)
      }
    })
    const turns = new PiRpcTurns({
      lane,
      generation: 'pi-generation',
      send: vi.fn(async () => {}),
      request: vi.fn(async () => ({})),
      settled: () => {},
      failed: (error) => {
        throw error
      },
      idle: () => {}
    })
    const input = new PassThrough()
    const output = new PassThrough()
    let records = 0
    const peer = new JsonlRpcPeer(input, output, {
      onRecord: (frame) => {
        turns.receive(frame)
        records++
        // Later stdout chunks remain in the Readable until terminal source transfer.
        if (pressured && frame.type === 'tool_execution_start') {
          peer.pauseReading()
        }
      },
      onClose: () =>
        lane.finalize({
          type: 'session.ended',
          verdict: { state: 'interrupted', completedAt: 9000 }
        })
    })
    try {
      if (pressured) {
        pressure(rig)
      }
      const prompt = frames
        .map((frame) => ({
          ...frame,
          value: z.looseObject({ type: z.string() }).parse(JSON.parse(frame.raw))
        }))
        .find((frame) => frame.dir === 'in' && frame.value.type === 'prompt')
      if (!prompt) {
        throw new Error('recorded prompt missing')
      }
      await turns.submit('recorded-send', 100, prompt.value)
      const delivered = frames.filter((frame) => frame.dir === 'out')
      for (const frame of delivered) {
        input.write(`${frame.raw}\n`)
      }
      if (pressured) {
        expect(records).toBeLessThan(delivered.length)
        expect(input.readableLength).toBeGreaterThan(0)
      }
      const completed = peer.finishOnInputEnd(new Error('recorded process exited'))
      input.end()
      await completed
      peer.close()
      const rows = await rig.rows()
      expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body] : []))).toEqual([
        expect.objectContaining({
          callId:
            'captured.id.000008.xxxxxxxxxxxxxxxxxx|captured.id.000009.xxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxx',
          state: 'failed',
          output: expect.objectContaining({
            head: 'capture-start\n\nCommand aborted',
            byteLength: 30,
            truncated: false
          })
        })
      ])
      expected = await saved(rig, expected)
    } finally {
      peer.close()
      turns.end()
      lane.dispose()
    }
  }
})
