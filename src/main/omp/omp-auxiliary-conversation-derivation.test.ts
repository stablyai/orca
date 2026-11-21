import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveOmpAuxiliaryConversation } from './omp-auxiliary-conversation-derivation'

const PARENT_ID = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
const UPDATED_AT = '2026-11-19T00:00:00.000Z'
const CWD = process.platform === 'win32' ? 'C:\\repo\\orca' : '/repo/orca'
const SHARED_DIR = process.platform === 'win32' ? 'C:\\repo\\shared' : '/repo/shared'
const TITLE_SLOT_BYTES = 256

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-omp-aux-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function titleSlotLine(title: string): string {
  const base = { type: 'title' as const, v: 1 as const, title, updatedAt: UPDATED_AT, pad: '' }
  const pad = ' '.repeat(TITLE_SLOT_BYTES - Buffer.byteLength(`${JSON.stringify(base)}\n`))
  return `${JSON.stringify({ ...base, pad })}\n`
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function user(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: UPDATED_AT,
    message: { role: 'user', content: text, attribution: 'user', timestamp: 1 }
  }
}

function assistant(id: string, parentId: string, content: unknown, stopReason: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: UPDATED_AT,
    message: {
      role: 'assistant',
      content,
      api: 'openai-responses',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {},
      stopReason,
      timestamp: 2
    }
  }
}

function parentLines(): string[] {
  return [
    titleSlotLine('Parent'),
    jsonLine({
      type: 'session',
      version: 3,
      id: PARENT_ID,
      timestamp: UPDATED_AT,
      cwd: CWD,
      title: 'Parent',
      additionalDirectories: [SHARED_DIR]
    }),
    jsonLine(user('a1', null, 'first')),
    jsonLine(assistant('a2', 'a1', [{ type: 'text', text: 'first answer' }], 'stop')),
    jsonLine({
      type: 'custom',
      id: 'd1',
      parentId: 'a2',
      timestamp: UPDATED_AT,
      customType: 'date-cwd-reminder',
      data: {
        conversation: 'user:1',
        turn: 'user:1',
        reminder: '<system-reminder>today</system-reminder>',
        placement: 'prefix'
      }
    }),
    jsonLine({
      type: 'custom',
      id: 'x1',
      parentId: 'd1',
      timestamp: UPDATED_AT,
      customType: 'session_exit',
      data: {}
    }),
    jsonLine({
      type: 'mode_change',
      id: 'g1',
      parentId: 'x1',
      timestamp: UPDATED_AT,
      mode: 'goal',
      data: { goal: { id: 'goal-1', objective: 'parent goal' } }
    }),
    jsonLine({
      type: 'custom_message',
      id: 'g2',
      parentId: 'g1',
      timestamp: UPDATED_AT,
      customType: 'goal-mode-context',
      content: '<goal_context>parent goal</goal_context>',
      display: false
    }),
    jsonLine({
      type: 'label',
      id: 'l1',
      parentId: 'g2',
      timestamp: UPDATED_AT,
      targetId: 'a2',
      label: 'kept'
    }),
    jsonLine(user('u2', 'l1', 'committed current input')),
    jsonLine(
      assistant(
        'a3',
        'u2',
        [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
        'toolUse'
      )
    ),
    jsonLine({
      type: 'message',
      id: 't1',
      parentId: 'a3',
      timestamp: UPDATED_AT,
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'incomplete turn' }],
        isError: false,
        timestamp: 3
      }
    }),
    jsonLine(user('s1', 'a2', 'sibling branch')),
    jsonLine(assistant('s2', 's1', [{ type: 'text', text: 'sibling answer' }], 'stop')),
    jsonLine({
      type: 'model_usage',
      id: 'm1',
      parentId: 's2',
      timestamp: UPDATED_AT,
      activeLeafId: 't1',
      purpose: 'title',
      api: 'openai-responses',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {},
      stopReason: 'stop'
    })
  ]
}

async function writeParent(
  lines = parentLines(),
  fileName = `2026-11-19T00-00-00-000Z_${PARENT_ID}.jsonl`
) {
  const path = join(root, fileName)
  // An in-flight JSONL tail is not newline-terminated and must be ignored.
  await writeFile(
    path,
    `${lines.join('')}${JSON.stringify(user('partial', 'm1', 'in-flight tail'))}`
  )
  return path
}

function readBody(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8')
}

describe('deriveOmpAuxiliaryConversation', () => {
  it('derives the active branch at the committed user and creates a clean v3 child', async () => {
    const sourcePath = await writeParent()
    const parentBefore = await readBody(sourcePath)

    const result = await deriveOmpAuxiliaryConversation({
      sourcePath,
      sourceNativeId: PARENT_ID,
      working: true
    })
    const child = await readBody(result.filePath)

    expect(dirname(result.filePath)).toBe(root)
    expect(basename(result.filePath)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/
    )
    expect(basename(result.filePath)).toContain(`_${result.sessionId}.jsonl`)
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(result.sessionId).not.toBe(PARENT_ID)

    const lines = child.split('\n')
    const titleLine = lines[0]
    const header = JSON.parse(lines[1])
    expect(JSON.parse(titleLine)).toMatchObject({
      type: 'title',
      v: 1,
      title: '',
      updatedAt: header.timestamp
    })
    expect(Buffer.byteLength(`${titleLine}\n`)).toBe(TITLE_SLOT_BYTES)
    expect(header).toMatchObject({
      type: 'session',
      version: 3,
      id: result.sessionId,
      cwd: CWD,
      additionalDirectories: [SHARED_DIR],
      parentSession: PARENT_ID,
      providerPromptCacheKey: PARENT_ID
    })
    expect(header.taskPromptCacheKey).toBeUndefined()
    expect(header.continuationOf).toBeUndefined()
    expect(header.previousSessionFiles).toBeUndefined()
    expect(child.endsWith('\n')).toBe(true)

    const entries = lines.slice(2, -1).map((line) => JSON.parse(line))
    expect(entries.map((entry) => entry.id)).toEqual(['a1', 'a2', 'd1', 'u2', entries.at(-1).id])
    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'message',
      'custom',
      'message',
      'message'
    ])
    expect(entries[0]).toMatchObject({ parentId: null })
    expect(entries[1]).toMatchObject({ parentId: 'a1' })
    expect(entries[2]).toMatchObject({
      parentId: 'a2',
      customType: 'date-cwd-reminder'
    })
    expect(entries[2].activeLeafId).toBeUndefined()
    expect(entries[3]).toMatchObject({
      parentId: 'd1',
      message: { role: 'user', content: 'committed current input' }
    })
    expect(entries[3].activeLeafId).toBeUndefined()
    expect(
      entries.some((entry) =>
        ['a3', 't1', 'x1', 's1', 's2', 'm1', 'g1', 'g2', 'l1'].includes(entry.id)
      )
    ).toBe(false)
    expect(entries.at(-1)).toMatchObject({
      parentId: 'u2',
      type: 'message',
      message: {
        role: 'user',
        synthetic: true,
        attribution: 'agent',
        content:
          "<system-reminder>\nThe preceding conversation was inherited from the parent task for reference only. Do not continue the parent's active work automatically; answer only new questions sent in this side chat. Modify the workspace only when the user explicitly asks you to do so in this side chat.\n</system-reminder>"
      }
    })

    expect(await readBody(sourcePath)).toBe(parentBefore)
    await result.discard()
    await expect(stat(result.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await result.discard()

    const idle = await deriveOmpAuxiliaryConversation({
      sourcePath,
      sourceNativeId: PARENT_ID,
      working: false
    })
    const idleEntries = (await readBody(idle.filePath))
      .split('\n')
      .slice(2, -1)
      .map((line) => JSON.parse(line))
    expect(idleEntries.map((entry) => entry.id)).toEqual([
      'a1',
      'a2',
      'd1',
      'u2',
      'a3',
      't1',
      idleEntries.at(-1).id
    ])
    expect(
      idleEntries.some((entry) => ['g1', 'g2', 'l1', 'x1', 's1', 's2', 'm1'].includes(entry.id))
    ).toBe(false)
    await idle.discard()
    expect(await readBody(sourcePath)).toBe(parentBefore)
  })

  it('rejects wrong native ids, non-v3 sessions, and non-absolute paths', async () => {
    const sourcePath = await writeParent()

    await expect(
      deriveOmpAuxiliaryConversation({
        sourcePath,
        sourceNativeId: '0198c2a5-0000-7000-8000-000000000000',
        working: true
      })
    ).rejects.toMatchObject({ code: 'session-mismatch' })

    const versionTwoPath = join(root, '2026-11-19T00-00-01-000Z_v2.jsonl')
    await writeFile(
      versionTwoPath,
      jsonLine({ type: 'session', version: 2, id: 'v2', timestamp: UPDATED_AT, cwd: CWD })
    )
    await expect(
      deriveOmpAuxiliaryConversation({
        sourcePath: versionTwoPath,
        sourceNativeId: 'v2',
        working: false
      })
    ).rejects.toMatchObject({ code: 'unsupported-version' })

    await expect(
      deriveOmpAuxiliaryConversation({
        sourcePath: `relative/${basename(sourcePath)}`,
        sourceNativeId: PARENT_ID,
        working: false
      })
    ).rejects.toMatchObject({ code: 'invalid-source' })
  })
})
