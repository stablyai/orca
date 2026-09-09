import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import { findNewestCodexStateDbPath } from './codex-state-db'

// Why this file exists: every other index-heal test drives a stub app-server and
// asserts "healed" as "the `thread/read` call did not error". That pins Orca's half
// of the contract and nothing about Codex's. The behavior Orca actually depends on
// lives in the Codex binary — a read of an unindexed rollout performs a read-repair
// that inserts the `threads` row. If Codex ever dropped that repair, the stub-driven
// tests would all stay green while the subsystem went silently inert. This is the
// real-binary backstop, built to the same shape as the Git binary compatibility
// contract in src/shared/git-binary-compatibility.test.ts.
//
// Keep it narrow. It pins the four arms that ablation established Orca relies on,
// and deliberately asserts nothing else about the app-server, so an unrelated Codex
// release does not redden it into being disabled.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_CONTRACT_VERSION
const describeCodexContract = binary ? describe : describe.skip

// Why this guard: skipping is the right local-dev default, but a CI job whose whole
// purpose is the real binary must not pass by reporting zero assertions. The job sets
// ORCA_CODEX_CONTRACT_REQUIRED=1, which turns a missing binary into a red test.
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

// Why fixed: `thread/read` never reaches the network, and a whole session is
// spawn + initialize + one RPC. A generous ceiling still fails fast on a wedged child.
const SESSION_TIMEOUT_MS = 60_000
// Why: each contract case can use three bounded app-server sessions; keep Vitest's
// watchdog longer than both child deadlines so cleanup cannot race a test timeout.
const CONTRACT_TEST_TIMEOUT_MS = SESSION_TIMEOUT_MS * 3 + 10_000

type ThreadRow = { id: string; archived: number }

describeCodexContract(
  'codex binary index-heal contract',
  { timeout: CONTRACT_TEST_TIMEOUT_MS },
  () => {
    const disposableHomes: string[] = []

    beforeAll(async () => {
      // Why assert the version: the whole point of a real-binary check is that the
      // binary drifts. A job that quietly ran some other Codex would report a
      // contract this repo never verified.
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

    /**
     * Builds a disposable CODEX_HOME in the state Orca actually heals from: Codex's
     * own one-shot sqlite backfill has already run and stamped itself `complete`, so
     * rollouts that appear afterwards are exactly the ones it will never index on its
     * own. Never points at the user's real ~/.codex.
     */
    async function createBackfilledCodexHome(): Promise<string> {
      const home = mkdtempSync(join(tmpdir(), 'orca-codex-heal-contract-'))
      disposableHomes.push(home)
      mkdirSync(join(home, 'sessions'), { recursive: true })
      // An app-server session over an empty sessions tree is what stamps the backfill complete.
      await runAppServerSession(home, async () => undefined)
      expect(readThreadRows(home)).toEqual([])
      return home
    }

    function writeRollout(home: string, threadId: string, stamp: string): void {
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
      writeFileSync(
        join(dayDir, `rollout-${stamp}-${threadId}.jsonl`),
        `${JSON.stringify(meta)}\n${JSON.stringify(userMessage)}\n`
      )
    }

    // Why reuse runCodexAppServerSession rather than a local JSON-RPC client: it is the
    // transport the heal itself uses, so a framing or handshake regression that would
    // break the heal breaks this check too.
    async function runAppServerSession<T>(
      home: string,
      body: (rpc: CodexAppServerRpc) => Promise<T>
    ): Promise<T> {
      return runCodexAppServerSession(
        {
          command: binary!,
          args: ['app-server'],
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

    // Arms 1 and 2 are one test on purpose: the "no read" pass is the negative control
    // that makes the insert causal rather than incidental. Split across two tests they
    // would run against two different homes and prove nothing about each other.
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

    // Why this arm: the heal reads tens of thousands of rollouts. If a read cleared
    // `archived`, the pass would silently resurrect every thread the user had archived.
    it('stamps an archived thread archived rather than resurrecting it', async () => {
      const home = await createBackfilledCodexHome()
      const threadId = '01a04f62-715e-7830-9371-50db585caa73'
      writeRollout(home, threadId, '2026-08-29T16-00-00')

      // The archived state is created here, never assumed: a real Codex home may
      // never have had a thread archived, and this arm would then pass vacuously.
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
