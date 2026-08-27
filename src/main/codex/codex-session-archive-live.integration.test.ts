import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'
import type { CodexSessionBackfillPaths } from './codex-session-backfill-types'
import type { CodexSessionIndexHealPaths } from './codex-session-index-heal-state'

const tempRoots: string[] = []
const runLiveTest = process.env.ORCA_RUN_LIVE_CODEX_ARCHIVE_TEST === '1'

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
  vi.resetModules()
})

describe.skipIf(!runLiveTest)('live Codex archive reconciliation', () => {
  it('keeps an officially archived task absent through two passes and a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-live-codex-archive-'))
    tempRoots.push(root)
    const systemHome = join(root, 'system-home')
    const managedSessionsRoot = join(root, 'managed-home', 'sessions')
    const stateDir = join(root, 'backfill-state')
    mkdirSync(systemHome, { recursive: true })

    const threadId = await withCodex(systemHome, async (request) => {
      const result = await request('thread/start', {})
      const id = readThreadId(result)
      await request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: 'Reply OK to this isolated archive lifecycle canary.' }]
      })
      return id
    })
    const sessionsRoot = join(systemHome, 'sessions')
    const activePath = findRolloutPath(sessionsRoot, threadId)
    const fileName = basename(activePath)
    const archivedPath = join(systemHome, 'archived_sessions', fileName)
    const managedPath = join(managedSessionsRoot, relative(sessionsRoot, activePath))
    mkdirSync(dirname(managedPath), { recursive: true })
    linkSync(activePath, managedPath)

    await withCodex(systemHome, async (request) => {
      await request('thread/read', { threadId })
      expect(await taskListContains(request, threadId, false)).toBe(true)
      await request('thread/archive', { threadId })
    })

    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)

    const backfillPaths: CodexSessionBackfillPaths = {
      managedSessionsRoot,
      systemSessionsRoot: join(systemHome, 'sessions'),
      systemArchivedSessionsRoot: join(systemHome, 'archived_sessions'),
      auditLogPath: join(stateDir, 'audit.jsonl'),
      markerPath: join(stateDir, 'backfill-complete.json')
    }
    const healPaths: CodexSessionIndexHealPaths = {
      auditLogPath: backfillPaths.auditLogPath,
      systemSessionsRoot: backfillPaths.systemSessionsRoot,
      systemArchivedSessionsRoot: backfillPaths.systemArchivedSessionsRoot,
      healLedgerPath: join(stateDir, 'index-heal-ledger.jsonl'),
      healMarkerPath: join(stateDir, 'index-heal-complete.json')
    }

    const firstHeal = await runReconciliationCycle(backfillPaths, healPaths, systemHome)
    expect(firstHeal.pendingThreads).toBe(0)
    vi.resetModules()
    const secondHeal = await runReconciliationCycle(backfillPaths, healPaths, systemHome)
    expect(secondHeal.pendingThreads).toBe(0)

    await withCodex(systemHome, async (request) => {
      expect(await taskListContains(request, threadId, false)).toBe(false)
      expect(await taskListContains(request, threadId, true)).toBe(true)
      await expect(request('thread/archive', { threadId })).rejects.toThrow(/no rollout found/)
      expect(await taskListContains(request, threadId, false)).toBe(false)
    })
    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
  }, 60_000)
})

type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>

async function withCodex<T>(systemHome: string, body: (request: Request) => Promise<T>) {
  return runCodexAppServerSession(
    {
      command: 'codex',
      args: ['app-server'],
      env: { CODEX_HOME: systemHome },
      timeoutMs: 20_000
    },
    ({ request }) => body(request)
  )
}

function readThreadId(result: unknown): string {
  const id = (result as { thread?: { id?: unknown } })?.thread?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('thread/start did not return a thread id')
  }
  return id
}

function findRolloutPath(sessionsRoot: string, threadId: string): string {
  const file = readdirSync(sessionsRoot, { recursive: true, encoding: 'utf-8' }).find((entry) =>
    entry.endsWith(`${threadId}.jsonl`)
  )
  if (!file) {
    throw new Error(`thread/start did not create a rollout for ${threadId}`)
  }
  return join(sessionsRoot, file)
}

async function taskListContains(request: Request, threadId: string, archived: boolean) {
  const result = await request('thread/list', { archived, limit: 100 })
  return JSON.stringify(result).includes(threadId)
}

async function runReconciliationCycle(
  backfillPaths: CodexSessionBackfillPaths,
  healPaths: CodexSessionIndexHealPaths,
  systemHome: string
) {
  const [{ backfillManagedCodexSessionsIntoSystemHome }, { runCodexSessionIndexHeal }] =
    await Promise.all([import('./codex-session-backfill'), import('./codex-session-index-heal')])
  await backfillManagedCodexSessionsIntoSystemHome(backfillPaths)
  return runCodexSessionIndexHeal(healPaths, {
    buildInvocation: () => ({
      command: 'codex',
      args: ['app-server'],
      env: { CODEX_HOME: systemHome },
      timeoutMs: 20_000
    }),
    interBatchDelayMs: 0
  })
}
