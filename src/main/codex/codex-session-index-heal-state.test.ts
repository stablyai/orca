import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_SESSION_INDEX_HEAL_VERSION,
  appendHealLedgerRecord,
  collectPendingHealThreads,
  isHealMarkerCurrent,
  writeHealMarker,
  type CodexSessionIndexHealPaths
} from './codex-session-index-heal-state'

const WINDOWS_SESSIONS_ROOT = 'C:\\Users\\Me\\.codex\\sessions'
const THREAD_ID = '019f0000-1111-7222-8333-000000000001'

let tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

function createPaths(systemSessionsRoot = WINDOWS_SESSIONS_ROOT): CodexSessionIndexHealPaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'orca-codex-heal-state-'))
  tempRoots.push(stateDir)
  return {
    auditLogPath: join(stateDir, 'audit.jsonl'),
    systemSessionsRoot,
    healLedgerPath: join(stateDir, 'index-heal-ledger.jsonl'),
    healMarkerPath: join(stateDir, 'index-heal-complete.json')
  }
}

function appendAuditRecord(paths: CodexSessionIndexHealPaths, target: string, recordId: string) {
  // Mirrors the real writer's leading newline, which quarantines a torn tail.
  appendFileSync(
    paths.auditLogPath,
    `\n${JSON.stringify({ action: 'hardlink', source: '/managed/x.jsonl', target, recordId })}\n`
  )
}

function windowsRolloutTarget(root: string): string {
  return `${root}\\2026\\07\\01\\rollout-2026-07-01T10-00-00-${THREAD_ID}.jsonl`
}

describe('codex session index heal state', () => {
  it('keeps the heal marker current across Windows spellings of one target', () => {
    const paths = createPaths()
    writeHealMarker(paths, 42, { healedThreads: 1, missingThreads: 0, failedThreads: 0 })

    for (const alias of ['C:/Users/Me/.codex/sessions', 'c:\\users\\me\\.codex\\sessions']) {
      expect(isHealMarkerCurrent({ ...paths, systemSessionsRoot: alias }, 42)).toBe(true)
    }
  })

  it('still re-heals when the real target path actually changes', () => {
    const paths = createPaths()
    writeHealMarker(paths, 42, { healedThreads: 1, missingThreads: 0, failedThreads: 0 })

    expect(
      isHealMarkerCurrent(
        { ...paths, systemSessionsRoot: 'C:\\Users\\Me\\moved-codex\\sessions' },
        42
      )
    ).toBe(false)
  })

  it('treats a heal record as processed regardless of how its root was spelled', async () => {
    const paths = createPaths()
    appendAuditRecord(paths, windowsRolloutTarget(WINDOWS_SESSIONS_ROOT), 'audit-1')
    appendHealLedgerRecord(
      { ...paths, systemSessionsRoot: 'c:/users/me/.codex/sessions' },
      THREAD_ID,
      'healed',
      'audit-1'
    )

    expect(await collectPendingHealThreads(paths)).toEqual([])
  })

  it('re-heals a thread whose record belongs to a different real home', async () => {
    const paths = createPaths()
    appendAuditRecord(paths, windowsRolloutTarget(WINDOWS_SESSIONS_ROOT), 'audit-1')
    appendHealLedgerRecord(
      { ...paths, systemSessionsRoot: 'C:\\Users\\Me\\moved-codex\\sessions' },
      THREAD_ID,
      'healed',
      'audit-1'
    )

    expect(await collectPendingHealThreads(paths)).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, auditRecordId: 'audit-1' })
    ])
  })

  it('re-queues a thread when a later publication event supersedes a healed one', async () => {
    const paths = createPaths()
    appendAuditRecord(paths, windowsRolloutTarget(WINDOWS_SESSIONS_ROOT), 'audit-1')
    appendHealLedgerRecord(paths, THREAD_ID, 'healed', 'audit-1')
    appendAuditRecord(paths, windowsRolloutTarget(WINDOWS_SESSIONS_ROOT), 'audit-2')

    expect(await collectPendingHealThreads(paths)).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, auditRecordId: 'audit-2' })
    ])
  })

  it('leaves the main thread free while walking a large audit ledger', async () => {
    const paths = createPaths()
    for (let index = 0; index < 20_000; index += 1) {
      appendAuditRecord(
        paths,
        `${WINDOWS_SESSIONS_ROOT}\\2026\\07\\01\\rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-${String(index).padStart(12, '0')}.jsonl`,
        `audit-${index}`
      )
    }
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)

    const pending = await collectPendingHealThreads(paths)
    clearInterval(ticker)

    expect(pending).toHaveLength(20_000)
    // A blocking readFileSync + whole-file JSON.parse would starve every timer.
    expect(ticks).toBeGreaterThan(0)
  })

  it('refuses to treat an unreadable audit ledger as an empty work queue', async () => {
    const paths = createPaths()
    // A directory in the audit's place surfaces EISDIR rather than ENOENT.
    mkdirSync(paths.auditLogPath, { recursive: true })

    await expect(collectPendingHealThreads(paths)).rejects.toThrow()
  })

  it('treats a missing audit ledger as no pending work', async () => {
    await expect(collectPendingHealThreads(createPaths())).resolves.toEqual([])
  })

  it('skips torn ledger lines instead of failing the pass', async () => {
    const paths = createPaths()
    appendFileSync(paths.auditLogPath, '{"action":"hardlink","target":"/x/rollout')
    appendAuditRecord(paths, windowsRolloutTarget(WINDOWS_SESSIONS_ROOT), 'audit-1')

    expect(await collectPendingHealThreads(paths)).toEqual([
      expect.objectContaining({ threadId: THREAD_ID })
    ])
    expect(CODEX_SESSION_INDEX_HEAL_VERSION).toBe(3)
  })
})
