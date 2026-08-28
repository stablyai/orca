import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { decodeKimiTranscriptLine } from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'

// Why: the per-line decoder tests cover record shapes in isolation; this feeds
// a realistic multi-turn wire.jsonl through the real stream path and asserts
// the assembled conversation end to end — including the records that must NOT
// render (append_message duplicates, injections, automation steers, llm
// payloads, usage bookkeeping).
const WIRE = [
  { type: 'metadata', protocol_version: '1.4', created_at: 1787558159918 },
  { type: 'config.update', profileName: 'agent', time: 1787558159918 },
  {
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'is there a bean repo on this box' }],
    origin: { kind: 'user' },
    time: 1787558233174
  },
  // The prompt's append_message twin — decoding it would double the bubble.
  {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'is there a bean repo on this box' }],
      toolCalls: [],
      origin: { kind: 'user' }
    },
    time: 1787558233175
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'step.begin', uuid: 's-1', turnId: '0', step: 1 },
    time: 1787558233222
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: 'p-1',
      turnId: '0',
      step: 1,
      stepUuid: 's-1',
      part: { type: 'think', think: 'Need to find candidate directories.' }
    },
    time: 1787558235000
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: 'p-2',
      turnId: '0',
      step: 1,
      stepUuid: 's-1',
      part: { type: 'text', text: 'Let me look for it.' }
    },
    time: 1787558236000
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      uuid: 'Bash:0',
      turnId: '0',
      step: 1,
      stepUuid: 's-1',
      toolCallId: 'Bash:0',
      name: 'Bash',
      args: { command: "find /home/alex -maxdepth 2 -iname '*bean*'" },
      description: 'Running: find …',
      display: { kind: 'command', command: 'find …', cwd: '/repo', language: 'bash' }
    },
    time: 1787558237519
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      parentUuid: 'Bash:0',
      toolCallId: 'Bash:0',
      result: { output: '/home/alex/bean\n' }
    },
    time: 1787558238799
  },
  // An injection the harness stores as a user message — never a user bubble.
  {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'auto-permission notice' }],
      origin: { kind: 'injection' }
    },
    time: 1787558239000
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      uuid: 's-1',
      turnId: '0',
      step: 1,
      usage: { inputOther: 20866, output: 282, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason: 'tool_use'
    },
    time: 1787558240372
  },
  {
    type: 'usage.record',
    model: 'kimi-for-coding',
    usage: { output: 282 },
    usageScope: 'turn',
    time: 1787558240372
  },
  { type: 'llm.request', time: 1787558241000 },
  // A background-task steer mid-session: automation, not conversation.
  {
    type: 'turn.steer',
    input: [{ type: 'text', text: '<notification id="task:bash-x:completed"/>' }],
    origin: { kind: 'background_task', taskId: 'bash-x', status: 'completed' },
    time: 1787558242000
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: 'p-3',
      turnId: '0',
      step: 2,
      stepUuid: 's-2',
      part: { type: 'text', text: 'Yes — /home/alex/bean exists.' }
    },
    time: 1787558245000
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'step.end', uuid: 's-2', turnId: '0', step: 2, finishReason: 'end_turn' },
    time: 1787558246000
  },
  // A cancelled turn leaves a marker, not silence.
  {
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'now delete it' }],
    origin: { kind: 'user' },
    time: 1787558250000
  },
  { type: 'turn.cancel', time: 1787558251000 }
]

describe('decodeTranscriptStream over a realistic kimi wire.jsonl', () => {
  it('assembles the conversation with no duplicates and no harness noise', async () => {
    const stream = Readable.from([`${WIRE.map((r) => JSON.stringify(r)).join('\n')}\n`])
    const { messages } = await decodeTranscriptStream(
      stream,
      '/sessions/wd_repo_x/session_1/agents/main/wire.jsonl',
      0,
      decodeKimiTranscriptLine,
      false
    )

    const summary = messages.map((m) => [
      m.role,
      m.blocks.map((b) => (b.type === 'text' ? b.text : b.type)).join('|')
    ])
    expect(summary).toEqual([
      ['user', 'is there a bean repo on this box'],
      ['assistant', 'Need to find candidate directories.'],
      ['assistant', 'Let me look for it.'],
      ['assistant', 'tool-call'],
      ['tool', 'tool-result'],
      ['assistant', 'Yes — /home/alex/bean exists.'],
      ['user', 'now delete it'],
      ['system', 'Conversation interrupted']
    ])

    // The tool call keeps its args and the result its output; ids carry the
    // toolCallId anchored to the line (rewind-safe).
    const call = messages.find(
      (m) => m.blocks[0]?.type === 'tool-call' && m.blocks[0].name === 'Bash'
    )
    expect(call?.id.startsWith('Bash:0:')).toBe(true)
    expect(call?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'Bash',
      input: { command: "find /home/alex -maxdepth 2 -iname '*bean*'" }
    })
    const result = messages.find((m) => m.blocks[0]?.type === 'tool-result')
    expect(result?.id.endsWith(':result')).toBe(true)
    expect(result?.blocks[0]).toEqual({ type: 'tool-result', output: '/home/alex/bean\n' })

    // Timestamps come through on every record so ordering is stable.
    expect(messages.every((m) => typeof m.timestamp === 'number')).toBe(true)
  })
})
