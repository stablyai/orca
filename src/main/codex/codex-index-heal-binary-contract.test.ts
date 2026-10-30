import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import SyncDatabase from '../sqlite/sync-database'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import { findNewestCodexStateDbPath, readCodexStateDbBackfillStatus } from './codex-state-db'

// A real binary must prove thread/read inserts unindexed rollouts; mocked RPC success cannot.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_CONTRACT_VERSION
const describeCodexContract = binary ? describe : describe.skip

// CI-required contracts must fail rather than silently skip when the binary is missing.
describe.runIf(process.env.ORCA_CODEX_CONTRACT_REQUIRED === '1' && !binary)(
  'codex binary index-heal contract prerequisites',
  () => {
    it('was given a Codex binary to run against', () => {
      expect.fail(
        'ORCA_CODEX_CONTRACT_REQUIRED=1 but ORCA_CODEX_CONTRACT_BINARY is unset, so the contract would have silently skipped'
      )
    })
  }
)

// Bound local spawn/initialize/read sessions, including wedged children.
const SESSION_TIMEOUT_MS = 60_000
// Allow three child deadlines plus cleanup before Vitest's watchdog fires.
const CONTRACT_TEST_TIMEOUT_MS = SESSION_TIMEOUT_MS * 3 + 10_000

type ThreadRow = { id: string; archived: number }

describeCodexContract(
  'codex binary index-heal contract',
  { timeout: CONTRACT_TEST_TIMEOUT_MS },
  () => {
    const disposableHomes: string[] = []

    beforeAll(async () => {
      const { stdout } = await execFileAsync(binary!, ['--version'], {
        timeout: SESSION_TIMEOUT_MS
      })
      expect(stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    })

    afterEach(() => {
      while (disposableHomes.length > 0) {
        rmSync(disposableHomes.pop() as string, { recursive: true, force: true })
      }
    })

    // Complete one-shot backfill before adding rollouts, matching the account bridge's repair case.
    async function createBackfilledCodexHome(): Promise<string> {
      const home = mkdtempSync(join(tmpdir(), 'orca-codex-heal-contract-'))
      disposableHomes.push(home)
      mkdirSync(join(home, 'sessions'), { recursive: true })
      // An empty-tree session stamps backfill complete without thread/read.
      await runAppServerSession(home, async () => undefined)
      expect(readCodexStateDbBackfillStatus(home).kind).toBe('complete')
      expect(readThreadRows(home)).toEqual([])
      return home
    }

    function writeRollout(
      home: string,
      threadId: string,
      stamp: string,
      options: { compressed?: boolean } = {}
    ): void {
      const dayDir = join(home, 'sessions', '2026', '08', '29')
      mkdirSync(dayDir, { recursive: true })
      const meta = {
        timestamp: '2026-08-29T21:17:33.760Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          session_id: threadId,
          id: threadId,
          timestamp: '2026-08-29T21:17:26.840Z',
          cwd: tmpdir(),
          originator: 'codex-tui',
          cli_version: expectedVersion,
          source: 'cli',
          thread_source: 'user',
          model_provider: 'openai'
        }
      }
      const userMessage = {
        timestamp: '2026-08-29T21:17:40.000Z',
        ordinal: 1,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'index-heal contract fixture' }
      }
      const contents = `${JSON.stringify(meta)}\n${JSON.stringify(userMessage)}\n`
      const fileName = `rollout-${stamp}-${threadId}.jsonl`
      if (options.compressed) {
        writeFileSync(join(dayDir, `${fileName}.zst`), zstdCompressSync(contents))
      } else {
        writeFileSync(join(dayDir, fileName), contents)
      }
    }

    // Use the heal's transport to catch framing and handshake regressions too.
    async function runAppServerSession<T>(
      home: string,
      body: (rpc: CodexAppServerRpc) => Promise<T>
    ): Promise<T> {
      return runCodexAppServerSession(
        {
          command: binary!,
          // Match heal/account state-DB creation arguments.
          args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
          cliPath: binary!,
          env: { CODEX_HOME: home },
          timeoutMs: SESSION_TIMEOUT_MS
        },
        body
      )
    }

    function readThreadRows(home: string): ThreadRow[] {
      const stateDbPath = findNewestCodexStateDbPath(home)
      if (!stateDbPath) {
        return []
      }
      const db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
      try {
        return db
          .prepare('SELECT id, archived FROM threads ORDER BY id')
          .all() as unknown as ThreadRow[]
      } finally {
        db.close()
      }
    }

    // Share one home with the no-read control to prove thread/read causes the insert.
    it('inserts the state row because of the read, not because the server ran', async () => {
      const home = await createBackfilledCodexHome()
      const threadId = '01a04f62-715e-7830-9371-50db585caa71'
      writeRollout(home, threadId, '2026-08-29T14-17-26')

      // Control: a complete app-server session that issues no `thread/read`.
      await runAppServerSession(home, async () => undefined)
      expect(readThreadRows(home)).toEqual([])

      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
      })

      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 0 }])
    })

    // The account bridge also links compressed history for this repair.
    it('indexes a compressed-only rollout on read', async () => {
      const home = await createBackfilledCodexHome()
      const threadId = '01a04f62-715e-7830-9371-50db585caa74'
      writeRollout(home, threadId, '2026-08-29T17-00-00', { compressed: true })

      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
      })

      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 0 }])
    })

    it('leaves an already-indexed thread as a single row', async () => {
      const home = await createBackfilledCodexHome()
      const threadId = '01a04f62-715e-7830-9371-50db585caa72'
      writeRollout(home, threadId, '2026-08-29T15-00-00')

      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
      })
      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 0 }])

      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
      })

      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 0 }])
    })

    it('stamps an archived thread archived rather than resurrecting it', async () => {
      const home = await createBackfilledCodexHome()
      const threadId = '01a04f62-715e-7830-9371-50db585caa73'
      writeRollout(home, threadId, '2026-08-29T16-00-00')

      // Establish archived state explicitly so the preservation check cannot pass vacuously.
      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
        await rpc.request('thread/archive', { threadId })
      })
      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 1 }])

      await runAppServerSession(home, async (rpc) => {
        await rpc.request('thread/read', { threadId })
      })

      expect(readThreadRows(home)).toEqual([{ id: threadId, archived: 1 }])
    })
  }
)
