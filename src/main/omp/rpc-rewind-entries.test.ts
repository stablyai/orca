import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { piBranchInTree } from '../pi/rpc-history-import'
import type { PiRpcConnection } from '../pi/rpc-session'
import { readOmpRewindEntries } from './rpc-rewind-entries'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(lines: object[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-rewind-entries-'))
  roots.push(root)
  const file = join(root, 'session.jsonl')
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}

const lines = [
  { type: 'title', v: 1, title: 'Saved conversation' },
  { type: 'session', version: 3, id: 'native-session' },
  { type: 'mode_change', id: 'mode', parentId: null, mode: 'chat' },
  {
    type: 'message',
    id: 'u1',
    parentId: 'mode',
    message: { role: 'user', timestamp: 100, content: 'first prompt' }
  },
  {
    type: 'message',
    id: 'tool',
    parentId: 'u1',
    message: { role: 'toolResult', content: 'large tool output' }
  },
  {
    type: 'custom_message',
    id: 'skill',
    parentId: 'tool',
    customType: 'skill-prompt',
    attribution: 'user',
    timestamp: '2026-11-04T00:00:00.000Z',
    content: 'skill instructions'
  },
  {
    type: 'message',
    id: 'abandoned',
    parentId: 'tool',
    message: { role: 'assistant', content: 'other branch' }
  }
]

it('reads a compact saved tree after native history exceeds the transport limit, using the native leaf', async () => {
  const file = await fixture(lines)
  const request: PiRpcConnection['request'] = async (_command, params) => {
    if (params?.since === undefined) {
      throw new JsonlRpcResponseError('get_entries', 'RPC response exceeded the transport limit')
    }
    if (params.since !== 'abandoned') {
      throw new Error('Unknown entries cursor')
    }
    return {
      entries: [
        {
          type: 'message',
          id: 'new',
          parentId: 'skill',
          message: { role: 'user', timestamp: 200, content: 'new prompt' }
        }
      ],
      leafId: 'new'
    }
  }
  const answer = await readOmpRewindEntries({ request }, file)
  const branch = piBranchInTree(answer, null)
  expect(branch).toEqual({
    rewound: false,
    path: [
      { type: 'mode_change', id: 'mode', parentId: null, mode: 'chat' },
      { type: 'message', id: 'u1', parentId: 'mode', message: { role: 'user', timestamp: 100 } },
      { type: 'message', id: 'tool', parentId: 'u1' },
      {
        type: 'custom_message',
        id: 'skill',
        parentId: 'tool',
        customType: 'skill-prompt',
        attribution: 'user',
        timestamp: '2026-11-04T00:00:00.000Z'
      },
      { type: 'message', id: 'new', parentId: 'skill', message: { role: 'user', timestamp: 200 } }
    ]
  })
  expect(answer.entries.find((entry) => entry.id === 'abandoned')).toEqual({
    type: 'message',
    id: 'abandoned',
    parentId: 'tool'
  })
})

it('refuses a saved tree that changes while its native cursor is being confirmed', async () => {
  const file = await fixture(lines)
  const request: PiRpcConnection['request'] = async (_command, params) => {
    if (params?.since === undefined) {
      throw new JsonlRpcResponseError('get_entries', 'RPC response exceeded the transport limit')
    }
    await appendFile(
      file,
      '{"type":"mode_change","id":"changed","parentId":"abandoned","mode":"goal"}\n'
    )
    return { entries: [], leafId: 'skill' }
  }
  await expect(readOmpRewindEntries({ request }, file)).rejects.toThrow('OMP session changed')
})

it('does not substitute disk history when native history or the confirmation cursor is unavailable', async () => {
  const file = await fixture(lines)
  const unavailable: PiRpcConnection['request'] = async () => {
    throw new Error('disconnected')
  }
  await expect(readOmpRewindEntries({ request: unavailable }, file)).rejects.toThrow('disconnected')
  const unknownCursor: PiRpcConnection['request'] = async (_command, params) => {
    throw new JsonlRpcResponseError(
      'get_entries',
      params?.since === undefined
        ? 'RPC response exceeded the transport limit'
        : 'Unknown entries cursor'
    )
  }
  await expect(readOmpRewindEntries({ request: unknownCursor }, file)).rejects.toThrow(
    'Unknown entries cursor'
  )
})
