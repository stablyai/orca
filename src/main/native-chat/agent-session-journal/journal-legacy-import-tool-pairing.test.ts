import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { foldToolMessages, pairToolBlocks } from '../../../shared/native-chat-tool-fold'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat-transcript-projection'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function importRows(records: unknown[], agent: 'claude' | 'codex' = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'orca-import-tool-pairing-'))
  roots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const prepared = await prepareLegacyTranscriptImport({
    agent,
    sessionId: 'imported-session',
    options: { filePath }
  })
  if (!prepared.ok) {
    throw new Error(prepared.error)
  }
  const items: AgentJournalRenderItem[] = prepared.items.map((item, index) => ({
    itemId: agentJournalItemKey(item.identity),
    body: item.body,
    revision: 0,
    sequence: index + 1,
    observedAt: item.observedAt ?? index + 1
  }))
  const messages = projectStructuredItemsToNativeChat(items)
  const pairs = foldToolMessages(messages).flatMap((message) => pairToolBlocks(message.blocks))
  return { items, messages, pairs }
}

function claudeRecord(uuid: string, role: 'assistant' | 'user', content: unknown) {
  return {
    type: role,
    uuid,
    sessionId: 'imported-session',
    timestamp: '2026-10-09T10:00:00.000Z',
    message: { role, content }
  }
}

function claudeCall(id: string | undefined, command: string) {
  return {
    type: 'tool_use',
    ...(id !== undefined ? { id } : {}),
    name: 'Bash',
    input: { command }
  }
}

function claudeResult(toolUseId: string | undefined, content: string, isError = false) {
  return {
    type: 'tool_result',
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
    content,
    ...(isError ? { is_error: true } : {})
  }
}

describe('legacy import tool identity', () => {
  it('pairs batched named results with separately imported calls past a silent call', async () => {
    const { items, pairs } = await importRows([
      claudeRecord('silent-call', 'assistant', [claudeCall('silent', 'echo silent')]),
      claudeRecord('first-call', 'assistant', [claudeCall('first', 'echo first')]),
      claudeRecord('second-call', 'assistant', [claudeCall('second', 'echo second')]),
      claudeRecord('results', 'user', [
        claudeResult('second', 'SECOND', true),
        claudeResult('first', 'FIRST')
      ])
    ])
    expect(pairs).toMatchObject([
      { call: { callId: 'silent', input: { command: 'echo silent' } } },
      {
        call: { callId: 'first', input: { command: 'echo first' } },
        result: { callId: 'first', output: 'FIRST' }
      },
      {
        call: { callId: 'second', input: { command: 'echo second' } },
        result: { callId: 'second', output: 'SECOND', isError: true }
      }
    ])
    expect(pairs[0]?.result).toBeUndefined()
    expect(items.slice(0, 3).map((item) => item.body)).toMatchObject([
      { kind: 'tool-call', callId: 'silent' },
      { kind: 'tool-call', callId: 'first' },
      { kind: 'tool-call', callId: 'second' }
    ])
  })

  it('keeps identity consistent across single-call and multi-call import records', async () => {
    const { pairs } = await importRows([
      claudeRecord('first-call', 'assistant', [claudeCall('first', 'echo first')]),
      claudeRecord('more-calls', 'assistant', [
        claudeCall('second', 'echo second'),
        claudeCall('third', 'echo third')
      ]),
      claudeRecord('results', 'user', [
        claudeResult('third', 'THIRD'),
        claudeResult('second', 'SECOND'),
        claudeResult('first', 'FIRST')
      ])
    ])
    expect(pairs.map((pair) => [pair.call?.callId, pair.result?.output])).toEqual([
      ['first', 'FIRST'],
      ['second', 'SECOND'],
      ['third', 'THIRD']
    ])
  })

  it('preserves FIFO for duplicate provider IDs', async () => {
    const { pairs } = await importRows([
      claudeRecord('first-call', 'assistant', [claudeCall('same', 'echo first')]),
      claudeRecord('second-call', 'assistant', [claudeCall('same', 'echo second')]),
      claudeRecord('results', 'user', [
        claudeResult('same', 'FIRST'),
        claudeResult('same', 'SECOND')
      ])
    ])
    expect(pairs.map((pair) => [pair.call?.input, pair.result?.output])).toEqual([
      [{ command: 'echo first' }, 'FIRST'],
      [{ command: 'echo second' }, 'SECOND']
    ])
  })

  it('pairs singleton result records with real calls instead of inventing extra invocations', async () => {
    const { items, pairs } = await importRows([
      claudeRecord('silent-call', 'assistant', [claudeCall('silent', 'echo silent')]),
      claudeRecord('first-call', 'assistant', [claudeCall('first', 'echo first')]),
      claudeRecord('second-call', 'assistant', [claudeCall('second', 'echo second')]),
      {
        ...claudeRecord('second-output', 'user', [claudeResult('second', 'SECOND', true)]),
        toolUseResult: {
          filePath: 'example.ts',
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }
          ]
        }
      },
      claudeRecord('first-output', 'user', [claudeResult('first', 'FIRST')])
    ])
    expect(
      pairs.map((pair) => [pair.call?.callId, pair.result?.output, pair.result?.isError])
    ).toEqual([
      ['silent', undefined, undefined],
      ['first', 'FIRST', undefined],
      ['second', 'SECOND', true]
    ])
    expect(items.slice(3).map((item) => item.body)).toMatchObject([
      { kind: 'message', blocks: [{ type: 'tool-result', callId: 'second', isError: true }] },
      { kind: 'message', blocks: [{ type: 'tool-result', callId: 'first' }] }
    ])
    expect(pairs[2]?.result?.editPatch).toEqual({
      filePath: 'example.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
    })
  })

  it('preserves the exact TodoWrite call each singleton acceptance or rejection answers', async () => {
    const todo = (id: string, content: string) => ({
      type: 'tool_use',
      id,
      name: 'TodoWrite',
      input: { todos: [{ content, status: 'pending' }] }
    })
    const { pairs } = await importRows([
      claudeRecord('accepted-call', 'assistant', [todo('accepted', 'Keep accepted')]),
      claudeRecord('accepted-result', 'user', [claudeResult('accepted', 'ACCEPTED')]),
      claudeRecord('rejected-call', 'assistant', [todo('rejected', 'Discard rejected')]),
      claudeRecord('rejected-result', 'user', [claudeResult('rejected', 'REJECTED', true)])
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs).toMatchObject([
      {
        call: {
          callId: 'accepted',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Keep accepted', status: 'pending' }] }
        },
        result: { callId: 'accepted', output: 'ACCEPTED' }
      },
      {
        call: {
          callId: 'rejected',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Discard rejected', status: 'pending' }] }
        },
        result: { callId: 'rejected', output: 'REJECTED', isError: true }
      }
    ])
    expect(pairs[0]?.result?.isError).toBeUndefined()
  })

  it('keeps legacy calls and results without provider IDs positional', async () => {
    const { items, pairs } = await importRows([
      claudeRecord('first-call', 'assistant', [claudeCall(undefined, 'echo first')]),
      claudeRecord('second-call', 'assistant', [claudeCall(undefined, 'echo second')]),
      claudeRecord('results', 'user', [
        claudeResult(undefined, 'FIRST'),
        claudeResult(undefined, 'SECOND')
      ])
    ])
    expect(pairs.map((pair) => [pair.call?.input, pair.result?.output])).toEqual([
      [{ command: 'echo first' }, 'FIRST'],
      [{ command: 'echo second' }, 'SECOND']
    ])
    expect(Object.hasOwn(items[0]?.body ?? {}, 'callId')).toBe(false)
    expect(Object.hasOwn(items[1]?.body ?? {}, 'callId')).toBe(false)
  })

  it('keeps outputs from already imported journals visible without guessing their call ownership', async () => {
    const { items } = await importRows([
      claudeRecord('first-call', 'assistant', [claudeCall('first', 'echo first')]),
      claudeRecord('second-call', 'assistant', [claudeCall('second', 'echo second')]),
      claudeRecord('results', 'user', [
        claudeResult('second', 'SECOND', true),
        claudeResult('first', 'FIRST')
      ])
    ])
    const oldItems = items.map((item) =>
      item.body.kind === 'tool-call'
        ? {
            ...item,
            body: {
              kind: 'tool-call' as const,
              name: item.body.name,
              input: item.body.input,
              state: item.body.state
            }
          }
        : item
    )
    const projected = projectNativeChatTranscriptMessages(
      projectStructuredItemsToNativeChat(oldItems)
    )
    const pairs = projected.flatMap((message) => pairToolBlocks(message.blocks))
    expect(pairs.map((pair) => [pair.call?.input, pair.result?.output])).toEqual([
      [{ command: 'echo first' }, undefined],
      [{ command: 'echo second' }, undefined],
      [undefined, 'SECOND'],
      [undefined, 'FIRST']
    ])
    expect(projected[1]).toMatchObject({ role: 'tool', journalPosition: { sequence: 3, index: 0 } })
    expect(pairs[2]?.result?.isError).toBe(true)
    expect(projectNativeChatTranscriptMessages(projected)).toEqual(projected)
  })

  it.each(['function_call', 'custom_tool_call', 'local_shell_call'] as const)(
    'preserves Codex %s identity through the single-call import',
    async (type) => {
      const { items, messages } = await importRows(
        [
          {
            type: 'response_item',
            payload: {
              type,
              id: 'call-record',
              call_id: 'provider-call',
              name: 'exec',
              input: 'pwd'
            }
          }
        ],
        'codex'
      )
      expect(items[0]?.body).toMatchObject({ kind: 'tool-call', callId: 'provider-call' })
      expect(messages[0]?.blocks[0]).toMatchObject({ type: 'tool-call', callId: 'provider-call' })
    }
  )

  it.each([
    ['function_call', 'function_call_output'],
    ['custom_tool_call', 'custom_tool_call_output'],
    ['local_shell_call', 'function_call_output']
  ])('pairs Codex singleton %s and %s import records', async (callType, outputType) => {
    const { pairs } = await importRows(
      [
        {
          type: 'response_item',
          payload: {
            type: callType,
            id: 'call-record',
            call_id: 'provider-call',
            name: 'exec',
            input: 'pwd'
          }
        },
        {
          type: 'response_item',
          payload: {
            type: outputType,
            id: 'output-record',
            call_id: 'provider-call',
            output: 'PROVIDER OUTPUT'
          }
        }
      ],
      'codex'
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({
      call: { callId: 'provider-call' },
      result: { callId: 'provider-call', output: 'PROVIDER OUTPUT' }
    })
  })
})
