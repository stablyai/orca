import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { foldToolMessages, pairToolBlocks } from '../../shared/native-chat-tool-fold'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function load(records: unknown[], agent: 'claude' | 'codex'): Promise<NativeChatMessage[]> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-result-identity-'))
  roots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const page = await readNativeChatTranscriptTailFile(
    filePath,
    100,
    agent === 'claude' ? decodeClaudeTranscriptLine : decodeCodexTranscriptLine
  )
  expect(page.hasMore).toBe(false)
  return page.messages
}

function claudeRecord(id: string, role: 'assistant' | 'user', content: unknown): unknown {
  return {
    type: role,
    uuid: id,
    timestamp: '2026-10-09T10:00:00.000Z',
    message: { role, content }
  }
}

function codexRecord(id: string, payload: Record<string, unknown>, wrapped = true): unknown {
  return {
    timestamp: '2026-10-09T10:00:00.000Z',
    ...(wrapped ? { type: 'response_item', payload: { id, ...payload } } : { id, ...payload })
  }
}

function claudeCalls(): unknown[] {
  return [
    claudeRecord('calls', 'assistant', [
      { type: 'tool_use', id: 'spawn', name: 'spawn_agent', input: { task: 'Inspect' } },
      { type: 'tool_use', id: 'first', name: 'Bash', input: { command: 'echo first' } },
      { type: 'tool_use', id: 'second', name: 'Bash', input: { command: 'echo second' } }
    ])
  ]
}

function codexCalls(type: 'function_call' | 'custom_tool_call', wrapped: boolean): unknown[] {
  return ['spawn', 'first', 'second'].map((callId) =>
    codexRecord(
      `call-${callId}`,
      {
        type,
        call_id: callId,
        name: callId === 'spawn' ? 'spawn_agent' : 'exec_command',
        arguments: JSON.stringify({ command: `echo ${callId}` })
      },
      wrapped
    )
  )
}

function pairsFrom(messages: NativeChatMessage[]) {
  return foldToolMessages(messages).flatMap((message) => pairToolBlocks(message.blocks))
}

describe('provider transcript result identity', () => {
  it('keeps Claude reverse completions attached to their calls past a silent spawn', async () => {
    const messages = await load(
      [
        ...claudeCalls(),
        claudeRecord('results', 'user', [
          { type: 'tool_result', tool_use_id: 'second', content: 'SECOND', is_error: true },
          { type: 'tool_result', tool_use_id: 'first', content: ['FIRST', { text: 'detail' }] }
        ])
      ],
      'claude'
    )
    expect(messages.at(-1)?.blocks).toEqual([
      { type: 'tool-result', callId: 'second', output: 'SECOND', isError: true },
      { type: 'tool-result', callId: 'first', output: 'FIRST\ndetail' }
    ])
    expect(pairsFrom(messages)).toMatchObject([
      { call: { callId: 'spawn' } },
      { call: { callId: 'first' }, result: { callId: 'first', output: 'FIRST\ndetail' } },
      { call: { callId: 'second' }, result: { callId: 'second', output: 'SECOND', isError: true } }
    ])
    expect(pairsFrom(messages)[0]?.result).toBeUndefined()
  })

  it.each([
    ['function_call', 'function_call_output', true],
    ['custom_tool_call', 'custom_tool_call_output', true],
    ['function_call', 'function_call_output', false],
    ['custom_tool_call', 'custom_tool_call_output', false]
  ] as const)(
    'keeps Codex %s/%s results named (wrapped=%s)',
    async (callType, outputType, wrapped) => {
      const messages = await load(
        [
          ...codexCalls(callType, wrapped),
          codexRecord(
            'result-second',
            {
              type: outputType,
              call_id: 'second',
              output: { content: ['SECOND'], success: false }
            },
            wrapped
          ),
          codexRecord(
            'result-first',
            { type: outputType, call_id: 'first', output: { output: 'FIRST' } },
            wrapped
          )
        ],
        'codex'
      )
      expect(messages.slice(-2).map((message) => message.blocks[0])).toEqual([
        { type: 'tool-result', callId: 'second', output: 'SECOND', isError: true },
        { type: 'tool-result', callId: 'first', output: 'FIRST' }
      ])
      expect(pairsFrom(messages)).toMatchObject([
        { call: { callId: 'spawn' } },
        { call: { callId: 'first' }, result: { callId: 'first', output: 'FIRST' } },
        {
          call: { callId: 'second' },
          result: { callId: 'second', output: 'SECOND', isError: true }
        }
      ])
      expect(pairsFrom(messages)[0]?.result).toBeUndefined()
    }
  )

  it('preserves the result identity together with Claude resolved edit ranges and record metadata', async () => {
    const messages = await load(
      [
        {
          type: 'user',
          uuid: 'edit-result',
          parentUuid: 'edit-call',
          timestamp: '2026-10-09T10:01:00.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'edit', content: 'edited', is_error: true }
            ]
          },
          toolUseResult: {
            filePath: 'src/example.ts',
            structuredPatch: [
              { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }
            ]
          }
        }
      ],
      'claude'
    )
    expect(messages).toEqual([
      {
        id: 'edit-result',
        parentId: 'edit-call',
        role: 'tool',
        timestamp: Date.parse('2026-10-09T10:01:00.000Z'),
        source: 'transcript',
        blocks: [
          {
            type: 'tool-result',
            callId: 'edit',
            output: 'edited',
            isError: true,
            editPatch: {
              filePath: 'src/example.ts',
              hunks: [
                { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }
              ]
            }
          }
        ]
      }
    ])
  })

  it.each(['claude', 'codex'] as const)(
    'keeps historical %s results without IDs positional',
    async (agent) => {
      const records =
        agent === 'claude'
          ? [
              claudeRecord('calls', 'assistant', [
                { type: 'tool_use', id: 'first', name: 'Bash', input: {} },
                { type: 'tool_use', id: 'second', name: 'Bash', input: {} }
              ]),
              claudeRecord('results', 'user', [
                { type: 'tool_result', content: 'FIRST' },
                { type: 'tool_result', content: 'SECOND' }
              ])
            ]
          : [
              ...codexCalls('function_call', true).slice(1),
              codexRecord('first-result', { type: 'function_call_output', output: 'FIRST' }),
              codexRecord('second-result', { type: 'function_call_output', output: 'SECOND' })
            ]
      const messages = await load(records, agent)
      expect(pairsFrom(messages)).toMatchObject([
        { call: { callId: 'first' }, result: { output: 'FIRST' } },
        { call: { callId: 'second' }, result: { output: 'SECOND' } }
      ])
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.type === 'tool-result') {
            expect(Object.hasOwn(block, 'callId')).toBe(false)
          }
        }
      }
    }
  )

  it.each([null, '', ' ', 42, {}])('omits invalid provider result IDs (%s)', (callId) => {
    const claude = decodeClaudeTranscriptLine(
      JSON.stringify(
        claudeRecord('result', 'user', [
          { type: 'tool_result', tool_use_id: callId, content: 'done' }
        ])
      ),
      'fallback'
    )
    const codex = decodeCodexTranscriptLine(
      JSON.stringify(
        codexRecord('result', { type: 'function_call_output', call_id: callId, output: 'done' })
      ),
      'fallback'
    )
    expect(claude?.blocks).toEqual([{ type: 'tool-result', output: 'done' }])
    expect(codex?.blocks).toEqual([{ type: 'tool-result', output: 'done' }])
  })
})
