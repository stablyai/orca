import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as processRunner from '../../shared/child-process/run-process'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import SyncDatabase from '../sqlite/sync-database'
import { appendTurns, writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import { createOpenCodeSqliteProcessClient } from './session-scanner-opencode-sqlite-process-client'
import {
  OPENCODE_SQLITE_REQUEST_MAX_BYTES,
  OPENCODE_SQLITE_RESPONSE_MAX_BYTES
} from './session-scanner-opencode-sqlite-process-framing'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const bun =
  process.env.BUN_EXECUTABLE ?? resolve('out/orcad', orcadBunRuntimeFilename(process.platform))
const directory = mkdtempSync(join(tmpdir(), 'orca-opencode-process-'))
const entry = join(directory, 'reader.cjs')
const dbPath = join(directory, 'opencode.db')
const oversizedPath = join(directory, 'oversized.db')
const prompt = 'A complete first prompt. '.repeat(200)
let writer: SyncDatabase

beforeAll(async () => {
  await build({
    entryPoints: ['src/main/ai-vault/session-scanner-opencode-sqlite-process-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['bun:sqlite'],
    outfile: entry,
    logLevel: 'silent'
  })
  writeOpenCodeSqliteDatabase(dbPath, [{ id: 'wal-session', turns: [] }])
  writer = new SyncDatabase(dbPath)
  writer.pragma('journal_mode = WAL')
  writer.pragma('wal_autocheckpoint = 0')
  appendTurns(writer, { id: 'wal-session', turns: [{ role: 'user', parts: [prompt] }] }, Date.now())
  writeOpenCodeSqliteDatabase(oversizedPath, [
    {
      id: 'oversized',
      turns: Array.from({ length: 130 }, () => ({
        role: 'user' as const,
        parts: ['x'.repeat(256 * 1024)]
      }))
    }
  ])
})

afterAll(() => {
  writer?.close()
  rmSync(directory, { recursive: true, force: true })
})

for (const [runtime, executable] of [
  ['Node', process.execPath],
  ['Bun', bun]
]) {
  describe.skipIf(!existsSync(executable))(`OpenCode SQLite process under ${runtime}`, () => {
    it('uses the deployed runtime and reads live WAL, full prompts and captures in one persistent child', async () => {
      if (runtime === 'Bun') {
        expect((await runProcess({ program: executable, args: ['--version'] })).stdout.trim()).toBe(
          ORCAD_BUN_VERSION
        )
      }
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
      const spawn = vi.spyOn(processRunner, 'spawnProcess')
      const client = createOpenCodeSqliteProcessClient({
        executable,
        args: [entry],
        cwd: directory
      })
      try {
        const issues: AiVaultScanIssue[] = []
        const listed = await client.list({ dbPaths: [dbPath], limit: 5, issues })
        expect(issues).toEqual([])
        expect(listed).toHaveLength(1)
        expect(await client.list({ dbPaths: [dbPath], limit: Infinity, issues })).toHaveLength(1)
        const args = { dbPath, sessionId: 'wal-session', platform: process.platform }
        expect((await client.parse(args))?.firstUserPrompt).toBeUndefined()
        expect((await client.parse({ ...args, fullFirstUserPrompt: true }))?.firstUserPrompt).toBe(
          prompt.trim()
        )
        expect((await client.capture(args)).messages).toEqual([
          expect.objectContaining({ role: 'user', text: prompt })
        ])
        expect(spawn).toHaveBeenCalledOnce()
      } finally {
        client.dispose()
        spawn.mockRestore()
      }
    })

    it('fails oversized query responses without truncating a transcript and remains usable', async () => {
      const client = createOpenCodeSqliteProcessClient({ executable, args: [entry] })
      try {
        await expect(
          client.capture({
            dbPath: oversizedPath,
            sessionId: 'oversized',
            platform: process.platform
          })
        ).rejects.toThrow('response exceeds its byte limit')
        expect(
          await client.parse({ dbPath, sessionId: 'wal-session', platform: process.platform })
        ).not.toBeNull()
      } finally {
        client.dispose()
      }
    })

    it('exits on parent EOF even while SQLite is busy, and enforces its own hard deadline', async () => {
      const lockedPath = join(directory, `locked-${runtime}.db`)
      writeOpenCodeSqliteDatabase(lockedPath, [{ id: 'locked', turns: [] }])
      const lock = new SyncDatabase(lockedPath)
      lock.exec('BEGIN EXCLUSIVE')
      try {
        const request = `${JSON.stringify({
          id: 1,
          kind: 'parse',
          dbPath: lockedPath,
          sessionId: 'locked',
          platform: process.platform,
          timeoutMs: 100
        })}\n`
        const child = spawnProcess({ program: executable, args: [entry] })
        child.stderr.resume()
        child.stdout.resume()
        const exit = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
        child.stdin.on('error', () => {})
        child.stdin.write(request)
        expect(await exit).toBe(124)

        const eof = await runProcess({
          program: executable,
          args: [entry],
          input: request,
          timeoutMs: 2_000
        })
        expect(eof.timedOut).toBe(false)
        expect(eof.code).toBe(0)

        const client = createOpenCodeSqliteProcessClient({ executable, args: [entry] })
        const cancellation = new AbortController()
        try {
          const pending = client.parse({
            dbPath: lockedPath,
            sessionId: 'locked',
            platform: process.platform,
            signal: cancellation.signal
          })
          const rejected = expect(pending).rejects.toThrow('SQL read cancelled')
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
          cancellation.abort(new Error('SQL read cancelled'))
          await rejected
        } finally {
          client.dispose()
        }
      } finally {
        lock.exec('ROLLBACK')
        lock.close()
      }
    })

    it('rejects oversized request frames before running a query', async () => {
      const result = await runProcess({
        program: executable,
        args: [entry],
        input: 'x'.repeat(OPENCODE_SQLITE_REQUEST_MAX_BYTES + 1),
        timeoutMs: 2_000
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
    })
  })
}

describe('OpenCode SQLite process retirement', () => {
  const args = { dbPath, sessionId: 'wal-session', platform: process.platform }

  it('closes the child at idle expiry and creates one new reader for the next request', async () => {
    const spawn = vi.spyOn(processRunner, 'spawnProcess')
    const client = createOpenCodeSqliteProcessClient({
      executable: process.execPath,
      args: [entry],
      idleTeardownMs: 20
    })
    try {
      expect(await client.parse(args)).not.toBeNull()
      const firstChild = spawn.mock.results[0]?.value
      expect(firstChild).toBeDefined()
      await vi.waitFor(() => expect(firstChild.signalCode).toBe('SIGKILL'))
      expect(await client.parse(args)).not.toBeNull()
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      client.dispose()
      spawn.mockRestore()
    }
  })

  it('cancels an active read, enforces queue limits, and fails closed after disposal', async () => {
    const client = createOpenCodeSqliteProcessClient({
      executable: process.execPath,
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      requestTimeoutMs: 5_000
    })
    const signal = new AbortController()
    const active = client.parse({ ...args, signal: signal.signal }).catch((error: unknown) => error)
    const queued = Array.from({ length: 64 }, () =>
      client.parse(args).catch((error: unknown) => error)
    )
    await expect(client.parse(args)).rejects.toThrow('queue is full')
    signal.abort(new Error('read cancelled'))
    expect(await active).toMatchObject({ message: 'read cancelled' })
    client.dispose()
    expect(await Promise.all(queued)).toHaveLength(64)
    await expect(client.parse(args)).rejects.toThrow('disposed')
  })

  it('retires a silent process at timeout and rejects bounded stdout/input overflow', async () => {
    const silent = createOpenCodeSqliteProcessClient({
      executable: process.execPath,
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      requestTimeoutMs: 100
    })
    try {
      await expect(silent.parse(args)).rejects.toThrow('timed out')
    } finally {
      silent.dispose()
    }
    const noisy = createOpenCodeSqliteProcessClient({
      executable: process.execPath,
      args: [
        '-e',
        `process.stdin.once('data',()=>process.stdout.write('x'.repeat(${OPENCODE_SQLITE_RESPONSE_MAX_BYTES + 1})));`
      ]
    })
    try {
      await expect(noisy.parse(args)).rejects.toThrow('byte limit')
      await expect(
        noisy.parse({ ...args, dbPath: 'x'.repeat(OPENCODE_SQLITE_REQUEST_MAX_BYTES) })
      ).rejects.toThrow('byte limit')
    } finally {
      noisy.dispose()
    }
  })
})
