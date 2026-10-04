import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { parseDshSessionBytes } from './session-scanner-dsh-parser'
import { selectDshGenerationPaths } from './session-scanner-dsh-generations'
import { isAiVaultDeletableAgent } from '../../shared/ai-vault-session-deletion'
import type { TranscriptMessage } from './session-transcript-consumers'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const header = (version = 4, extra = {}) => ({
  type: 'session',
  version,
  id: 'history-proof',
  cwd: '/tmp/plain-folder',
  createdAt: 1790920000000,
  delegationDepth: 0,
  ...(version < 2 ? {} : { isSeeded: false }),
  ...extra
})
const message = (seq: number, text: string, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: 1790920000100 + seq,
  data: { id: `m${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] },
  surfaceOp: 'append'
})
const jsonl = (rows: unknown[]) =>
  Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
async function* chunks(bytes: Buffer) {
  for (let i = 0; i < bytes.length; i += 13) {
    yield bytes.subarray(i, i + 13)
  }
}
const file = (path = '/tmp/.dsh/sessions/project/history-proof/session.v4.jsonl') => ({
  path,
  mtimeMs: 1790920001000,
  modifiedAt: '2026-10-02T00:00:00.000Z'
})

describe('official DSH persistence', () => {
  it('selects numeric latest generation and refuses mixed encoding without reading older data', () => {
    expect(
      selectDshGenerationPaths([
        '/a/session.v2.jsonl',
        '/a/session.v10.jsonl',
        '/a/session.v04.jsonl',
        '/b/session.jsonl'
      ])
    ).toEqual(['/a/session.v10.jsonl', '/b/session.jsonl'])
    expect(selectDshGenerationPaths(['/a/session.v3.jsonl', '/a/session.v4.jsonl.zstd'])).toEqual(
      []
    )
    expect(isAiVaultDeletableAgent('dsh')).toBe(false)
  })
  it.each([0, 1, 2, 3, 4])(
    'reads historical format %s and filters injected/system/attempt records',
    async (version) => {
      const messages: TranscriptMessage[] = []
      const result = await parseDshSessionBytes(
        file(`/tmp/.dsh/sessions/p/s/session${version ? `.v${version}` : ''}.jsonl`),
        () =>
          chunks(
            jsonl([
              header(version),
              message(0, 'Injected noise', 'goal'),
              message(1, 'Human opening ask'),
              { type: 'assistant/attempt', seq: 2, time: 1790920000200, data: { stream: [] } },
              {
                type: 'assistant/message',
                seq: 3,
                time: 1790920000300,
                data: {
                  message: {
                    role: 'assistant',
                    source: { kind: 'model', model: 'test-only' },
                    content: [{ type: 'text', text: 'Synthetic parser fixture reply' }]
                  },
                  usage: { inputTokens: 4, outputTokens: 6 }
                }
              }
            ])
          ),
        'darwin',
        {},
        { active: true, push: (value) => messages.push(value) }
      )
      expect(result?.messageCount).toBe(2)
      expect(result?.totalTokens).toBe(10)
      expect(messages.map((m) => m.text)).toEqual([
        'Human opening ask',
        'Synthetic parser fixture reply'
      ])
      expect(result?.resumeCommand).toContain("dsh-tui --resume 'history-proof'")
    }
  )
  it('counts released packed deltas as seed slots without inventing conversation messages', async () => {
    const result = await parseDshSessionBytes(
      file('/tmp/.dsh/sessions/p/s/session.jsonl'),
      () =>
        chunks(
          jsonl([
            header(0, { parentSession: 'parent', seedLength: 3 }),
            {
              type: 'text-chunks',
              seq0: 0,
              time0: 1790920000000,
              data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['partial', 'delta'] }
            },
            message(2, 'Inherited ask'),
            message(3, 'Independent fork ask')
          ])
        ),
      'linux'
    )
    expect(result?.previewMessages.map((value) => value.text)).toEqual(['Independent fork ask'])
    expect(result?.messageCount).toBe(1)
  })
  it('excludes delegated children but preserves independent forks with their own prompts', async () => {
    expect(
      await parseDshSessionBytes(
        file(),
        () =>
          chunks(
            jsonl([
              header(4, { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 }),
              message(0, 'Child')
            ])
          ),
        'linux'
      )
    ).toBeNull()
    const result = await parseDshSessionBytes(
      file(),
      () =>
        chunks(
          jsonl([
            header(4, { parentSession: 'parent', isSeeded: true }),
            message(0, 'Inherited'),
            { type: 'session/end-seed', seq: 1, time: 1790920000101, data: { inherited: true } },
            message(2, 'Fork opening ask')
          ])
        ),
      'linux'
    )
    expect(result?.messageCount).toBe(1)
    expect(result?.previewMessages[0].text).toBe('Fork opening ask')
  })
  it('reads concatenated compressed frames with bounded chunks and ignores torn plaintext record', async () => {
    const bytes = Buffer.concat([
      zstdCompressSync(jsonl([header()])),
      zstdCompressSync(jsonl([message(0, 'Compressed opening ask')]))
    ])
    const result = await parseDshSessionBytes(
      file('/tmp/.dsh/sessions/p/s/session.v4.jsonl.zstd'),
      () => chunks(bytes),
      'linux'
    )
    expect(result?.previewMessages[0].text).toBe('Compressed opening ask')
    expect(
      (
        await parseDshSessionBytes(
          file(),
          () =>
            chunks(
              Buffer.concat([jsonl([header(), message(0, 'Saved')]), Buffer.from('{"type":"user')])
            ),
          'linux'
        )
      )?.messageCount
    ).toBe(1)
    await expect(
      parseDshSessionBytes(
        file('/tmp/.dsh/sessions/p/s/session.v4.jsonl.zstd'),
        () => chunks(bytes.subarray(0, -2)),
        'linux'
      )
    ).rejects.toThrow()
  })
  it('refuses future versions, sequence gaps and missing inherited seed boundary', async () => {
    await expect(
      parseDshSessionBytes(file(), () => chunks(jsonl([header(5)])), 'linux')
    ).rejects.toThrow('Unsupported')
    await expect(
      parseDshSessionBytes(file(), () => chunks(jsonl([header(), message(2, 'Gap')])), 'linux')
    ).rejects.toThrow('sequence gap')
    await expect(
      parseDshSessionBytes(
        file(),
        () => chunks(jsonl([header(4, { isSeeded: true }), message(0, 'Seed')])),
        'linux'
      )
    ).rejects.toThrow('boundary')
  })
  it.each([false, true])(
    'discovers latest before cap and reparses append/truncate (compressed: %s)',
    async (compressed) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-dsh-history-'))
      roots.push(root)
      const scanRoots = isolatedScanRoots(root)
      const sessionDir = join(scanRoots.dshSessionsDir, 'project', 'history-proof')
      await mkdir(sessionDir, { recursive: true })
      const suffix = compressed ? '.zstd' : ''
      const encode = (data: Buffer) => (compressed ? zstdCompressSync(data) : data)
      const path = join(sessionDir, `session.v4.jsonl${suffix}`)
      await writeFile(join(sessionDir, `session.v3.jsonl${suffix}`), 'Older unreadable generation')
      await writeFile(path, encode(jsonl([header(), message(0, 'Opening ask')])))
      await utimes(
        join(sessionDir, `session.v3.jsonl${suffix}`),
        new Date('2030-01-01'),
        new Date('2030-01-01')
      )
      const scan = () =>
        scanAiVaultSessions({
          ...scanRoots,
          limit: 20,
          limitPerAgent: 1,
          scopePaths: ['/tmp/plain-folder']
        })
      expect((await scan()).sessions.filter((s) => s.agent === 'dsh')).toHaveLength(1)
      await appendFile(path, encode(jsonl([message(1, 'Followup')])))
      expect((await scan()).sessions.find((s) => s.agent === 'dsh')?.messageCount).toBe(2)
      await writeFile(path, encode(jsonl([header(), message(0, 'Rewritten')])))
      expect((await scan()).sessions.find((s) => s.agent === 'dsh')?.messageCount).toBe(1)
      await writeFile(path, '{broken}\n')
      const failed = await scan()
      expect(failed.sessions.some((s) => s.agent === 'dsh')).toBe(false)
      expect(failed.issues.some((issue) => issue.agent === 'dsh')).toBe(true)
      expect(dirname(path)).toBe(sessionDir)
    }
  )
})
