import { lock } from 'proper-lockfile'
import type * as ProperLockfile from 'proper-lockfile'
import type * as CodexHomePaths from '../../configuration/homes/codex-home-paths'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordCodexSessionDeletion,
  createCodexRolloutVisibilityPredicate,
  withCodexRolloutPublication,
  withCodexSessionHistoryMutation
} from './codex-session-deletion-record'
import { syncSystemCodexSessionsIntoManagedHome } from '../bridges/codex-session-bridge'
import { bridgeCodexSessionsIntoAccountHome } from '../bridges/codex-account-session-bridge'
import {
  backfillManagedCodexSessionsIntoSystemHome,
  startCodexSessionBackfillInBackground,
  resolveCodexSessionBackfillPaths
} from '../backfill/codex-session-backfill'
import { readCodexThreadsForIndexHeal } from '../index/codex-session-index-heal'
import { collectPendingHealThreads } from '../index/codex-session-index-heal-state'
import { prepareCodexSessionResume } from '../resume/codex-session-resume-preparation'
import { prepareCodexAiVaultSessionResume } from '../resume/codex-ai-vault-session-resume'
import { resolveCodexResumeLaunch } from '../../../ipc/pty/host-env/codex-resume'
import { resolveCodexSessionResumeProvenance } from '../resume/codex-session-resume-home'
import { AI_VAULT_AGENT_SOURCES } from '../../../ai-vault/session-scanner-agent-sources'

const locks = vi.hoisted(() => ({ acquire: vi.fn() }))
vi.mock('proper-lockfile', async (importOriginal) => {
  const original = await importOriginal<typeof ProperLockfile>()
  locks.acquire.mockImplementation(original.lock)
  return { ...original, lock: locks.acquire }
})

const SESSION = '019f0000-1111-7222-8333-000000000001'
const OTHER = '019f0000-1111-7222-8333-000000000002'
let root: string
let systemHome: string
let managedHome: string

vi.mock('../../configuration/homes/codex-home-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexHomePaths>()
  return {
    ...actual,
    getSystemCodexHomePath: () => systemHome,
    getOrcaManagedCodexHomePath: () => managedHome
  }
})

function rollout(home: string, id = SESSION): string {
  return join(home, 'sessions', '2026', '10', '11', `rollout-2026-10-11T12-00-00-${id}.jsonl`)
}

function seed(home: string, id = SESSION): string {
  const path = rollout(home, id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
  return path
}

function backfillPaths() {
  return {
    managedSessionsRoot: join(managedHome, 'sessions'),
    systemSessionsRoot: join(systemHome, 'sessions'),
    auditLogPath: join(root, 'audit.jsonl'),
    markerPath: join(root, 'marker.json')
  }
}

beforeEach(() => {
  locks.acquire.mockClear()
  root = mkdtempSync(join(tmpdir(), 'orca-codex-resurrection-'))
  systemHome = join(root, 'system')
  managedHome = join(root, 'managed')
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('durable Codex session deletion', () => {
  it('does not acquire publication locks for existing regular bridge targets', async () => {
    const accountHome = join(root, 'account')
    for (const home of [systemHome, managedHome, accountHome]) {
      seed(home)
      seed(home, OTHER)
    }
    await syncSystemCodexSessionsIntoManagedHome()
    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: accountHome,
      sourceCodexHomePaths: [systemHome]
    })
    expect(summary.bridgedThreads.size).toBe(2)
    expect(locks.acquire).not.toHaveBeenCalled()
  })

  it('rechecks deletion state before writing when a pass snapshot is stale', async () => {
    const path = seed(systemHome)
    const canPublish = await createCodexRolloutVisibilityPredicate({ includePending: true })
    await recordCodexSessionDeletion(SESSION)
    expect(canPublish(path)).toBe(true)
    const publish = vi.fn(async () => true)
    expect(await withCodexRolloutPublication(path, false, publish)).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('skips publication while another process holds the session transaction lock', async () => {
    seed(systemHome)
    const record = join(root, 'orca', 'codex-session-deletions', `${SESSION}.tombstone`)
    mkdirSync(dirname(record), { recursive: true })
    const release = await lock(record, { realpath: false })
    try {
      await syncSystemCodexSessionsIntoManagedHome()
      expect(existsSync(rollout(managedHome))).toBe(false)
      await recordCodexSessionDeletion(SESSION)
    } finally {
      await release()
    }
    await syncSystemCodexSessionsIntoManagedHome()
    expect(existsSync(rollout(managedHome))).toBe(false)
  })

  it('defers a locked backfill file, finishes the audit, and retries it next pass', async () => {
    seed(managedHome)
    seed(managedHome, OTHER)
    const record = join(root, 'orca', 'codex-session-deletions', `${SESSION}.tombstone`)
    mkdirSync(dirname(record), { recursive: true })
    const paths = resolveCodexSessionBackfillPaths()
    const release = await lock(record, { realpath: false })
    try {
      const summary = await startCodexSessionBackfillInBackground({ yieldMs: 0 })
      expect(summary?.deferredFiles).toBe(1)
      expect(existsSync(rollout(systemHome))).toBe(false)
      expect(existsSync(rollout(systemHome, OTHER))).toBe(true)
      expect(existsSync(paths.markerPath)).toBe(false)
      expect(readFileSync(paths.auditLogPath, 'utf8')).toContain('run-summary')
    } finally {
      await release()
    }
    await startCodexSessionBackfillInBackground({ yieldMs: 0 })
    expect(existsSync(rollout(systemHome))).toBe(true)
    expect(existsSync(paths.markerPath)).toBe(true)
  })

  it('defers only the locked heal thread without recording a completed read', async () => {
    const record = join(root, 'orca', 'codex-session-deletions', `${SESSION}.tombstone`)
    mkdirSync(dirname(record), { recursive: true })
    const release = await lock(record, { realpath: false })
    const request = vi.fn().mockResolvedValue({ thread: { id: OTHER } })
    const onOutcome = vi.fn()
    const options = {
      buildInvocation: () => ({ command: 'stub', args: [], cliPath: null, timeoutMs: 1000 }),
      runSession: async (
        _invocation: unknown,
        operation: (rpc: { request: typeof request; notify: typeof request }) => Promise<void>
      ) => operation({ request, notify: request })
    }
    try {
      expect(
        await readCodexThreadsForIndexHeal(
          systemHome,
          [{ threadId: SESSION }, { threadId: OTHER }],
          onOutcome,
          options
        )
      ).toBe('deferred')
      expect(onOutcome).toHaveBeenCalledTimes(1)
      expect(onOutcome).toHaveBeenCalledWith({ threadId: OTHER }, 'healed')
    } finally {
      await release()
    }
    expect(
      await readCodexThreadsForIndexHeal(systemHome, [{ threadId: SESSION }], onOutcome, options)
    ).toBe('completed')
    expect(onOutcome).toHaveBeenCalledWith({ threadId: SESSION }, 'healed')
  })

  it('blocks system/account bridges and backfill while other sessions still publish', async () => {
    seed(systemHome)
    seed(systemHome, OTHER)
    seed(managedHome)
    await recordCodexSessionDeletion(SESSION)
    await syncSystemCodexSessionsIntoManagedHome()
    expect(existsSync(rollout(managedHome, OTHER))).toBe(true)
    const accountHome = join(root, 'account')
    await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: accountHome,
      sourceCodexHomePaths: [systemHome, managedHome]
    })
    expect(existsSync(rollout(accountHome))).toBe(false)
    expect(existsSync(rollout(accountHome, OTHER))).toBe(true)
    rmSync(rollout(systemHome))
    await backfillManagedCodexSessionsIntoSystemHome(backfillPaths(), { yieldMs: 0 })
    expect(existsSync(rollout(systemHome))).toBe(false)
  })

  it('checks the deletion record after a queued publisher acquires the session lock', async () => {
    seed(managedHome)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const deletion = withCodexSessionHistoryMutation(SESSION, async () => {
      await held
      await recordCodexSessionDeletion(SESSION)
    })
    const backfill = backfillManagedCodexSessionsIntoSystemHome(backfillPaths(), { yieldMs: 0 })
    release()
    await Promise.all([deletion, backfill])
    expect(existsSync(rollout(systemHome))).toBe(false)
  })

  it('omits completed deletions from history discovery but retains failed deletions for retry', async () => {
    const path = seed(systemHome)
    await recordCodexSessionDeletion(SESSION)
    const pendingScan = await AI_VAULT_AGENT_SOURCES.codex.createFilePredicate?.()
    expect(pendingScan?.(path)).toBe(true)
    await recordCodexSessionDeletion(SESSION, true)
    const completedScan = await AI_VAULT_AGENT_SOURCES.codex.createFilePredicate?.()
    expect(completedScan?.(path)).toBe(false)
    expect(completedScan?.(rollout(systemHome, OTHER))).toBe(true)
    expect(
      completedScan?.(
        `\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex\\sessions\\${path.split(/[\\/]/).at(-1)}`
      )
    ).toBe(true)
  })

  it('does not re-index a deletion from either the audit ledger or an already queued heal', async () => {
    const path = seed(systemHome)
    writeFileSync(
      join(root, 'audit.jsonl'),
      `${JSON.stringify({ action: 'hardlink', target: path })}\n`
    )
    await recordCodexSessionDeletion(SESSION)
    expect(
      await collectPendingHealThreads({
        auditLogPath: join(root, 'audit.jsonl'),
        systemSessionsRoot: join(systemHome, 'sessions'),
        healLedgerPath: join(root, 'heal.jsonl'),
        healMarkerPath: join(root, 'heal-marker.json')
      })
    ).toEqual([])
    const request = vi.fn()
    const onOutcome = vi.fn()
    await readCodexThreadsForIndexHeal(systemHome, [{ threadId: SESSION }], onOutcome, {
      buildInvocation: () => ({ command: 'stub', args: [], cliPath: null, timeoutMs: 1000 }),
      runSession: async (_invocation, operation) => operation({ request, notify: vi.fn() })
    })
    expect(request).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledWith({ threadId: SESSION }, 'missing')
  })

  it.each([false, true])(
    'starts fresh for a recorded deletion (complete: %s)',
    async (complete) => {
      const path = seed(systemHome)
      await recordCodexSessionDeletion(SESSION, complete)
      await expect(
        resolveCodexSessionResumeProvenance({
          sessionId: SESSION,
          transcriptPath: path,
          trustedCodexHomes: [systemHome],
          getSelectedAccountCodexHome: () => null,
          systemCodexHomePath: systemHome,
          sharedRuntimeCodexHomePath: managedHome
        })
      ).resolves.toEqual({ outcome: 'fresh', claimedCodexProvenance: true })
      const resolveVerifiedResumeHome = vi.fn(async () => systemHome)
      const launch = await resolveCodexResumeLaunch(`codex resume ${SESSION}`, {
        providerSession: { key: 'session_id', id: SESSION, transcriptPath: path },
        preparation: prepareCodexSessionResume({
          sessionId: SESSION,
          transcriptPath: path,
          trustedCodexHomes: [systemHome],
          getSelectedAccountCodexHome: () => null,
          systemCodexHomePath: systemHome,
          sharedRuntimeCodexHomePath: managedHome,
          resolveVerifiedResumeHome
        })
      })
      expect(launch).toMatchObject({
        command: 'codex',
        droppedResumeArgv: true,
        notifyResumeUnavailable: true
      })
      expect(resolveVerifiedResumeHome).not.toHaveBeenCalled()
      await expect(
        prepareCodexAiVaultSessionResume(
          {
            agent: 'codex',
            sessionId: SESSION,
            filePath: path,
            executionHostId: 'local',
            codexHome: null
          },
          {
            runtimeHome: null,
            systemCodexHomePath: systemHome,
            preparePinnedLaunchHome: vi.fn()
          }
        )
      ).rejects.toThrow('deleted')
    }
  )
})
