import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodexSessionBackfillPaths } from './codex-session-backfill-types'
import type { CodexSessionIndexHealPaths } from './codex-session-index-heal-state'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
  vi.resetModules()
})

describe('archived Codex session lifecycle', () => {
  it('stays archived through two reconciliation cycles and a module restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-archive-lifecycle-'))
    tempRoots.push(root)
    const id = '019f0000-1111-7222-8333-000000000001'
    const fileName = `rollout-2026-08-12T10-00-00-${id}.jsonl`
    const relativePath = join('2026', '08', '12', fileName)
    const managedSessionsRoot = join(root, 'managed-home', 'sessions')
    const systemSessionsRoot = join(root, 'system-home', 'sessions')
    const systemArchivedSessionsRoot = join(root, 'system-home', 'archived_sessions')
    const managedPath = join(managedSessionsRoot, relativePath)
    const activePath = join(systemSessionsRoot, relativePath)
    const archivedPath = join(systemArchivedSessionsRoot, fileName)
    const stateDir = join(root, 'state')
    const auditLogPath = join(stateDir, 'audit.jsonl')
    mkdirSync(dirname(managedPath), { recursive: true })
    mkdirSync(dirname(activePath), { recursive: true })
    mkdirSync(systemArchivedSessionsRoot, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(managedPath, 'rollout\n', 'utf-8')
    linkSync(managedPath, activePath)
    linkSync(managedPath, archivedPath)
    appendFileSync(
      auditLogPath,
      `${JSON.stringify({ action: 'hardlink', source: managedPath, target: activePath })}\n`,
      'utf-8'
    )

    const backfillPaths: CodexSessionBackfillPaths = {
      managedSessionsRoot,
      systemSessionsRoot,
      systemArchivedSessionsRoot,
      auditLogPath,
      markerPath: join(stateDir, 'backfill-complete.json')
    }
    const healPaths: CodexSessionIndexHealPaths = {
      auditLogPath,
      systemSessionsRoot,
      systemArchivedSessionsRoot,
      healLedgerPath: join(stateDir, 'index-heal-ledger.jsonl'),
      healMarkerPath: join(stateDir, 'index-heal-complete.json')
    }
    let appServerStarts = 0
    const healOptions = {
      buildInvocation: (): never => {
        appServerStarts += 1
        throw new Error('archived rollout must not start app-server heal')
      },
      interBatchDelayMs: 0
    }

    const firstModules = await loadLifecycleModules()
    await firstModules.backfillManagedCodexSessionsIntoSystemHome(backfillPaths)
    await firstModules.runCodexSessionIndexHeal(healPaths, healOptions)
    await firstModules.backfillManagedCodexSessionsIntoSystemHome(backfillPaths)
    await firstModules.runCodexSessionIndexHeal(healPaths, healOptions)

    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
    expect(appServerStarts).toBe(0)

    vi.resetModules()
    const restartedModules = await loadLifecycleModules()
    await restartedModules.backfillManagedCodexSessionsIntoSystemHome(backfillPaths)
    await restartedModules.runCodexSessionIndexHeal(healPaths, healOptions)

    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
    expect(appServerStarts).toBe(0)
  })
})

async function loadLifecycleModules() {
  const [backfill, heal] = await Promise.all([
    import('./codex-session-backfill'),
    import('./codex-session-index-heal')
  ])
  return {
    backfillManagedCodexSessionsIntoSystemHome: backfill.backfillManagedCodexSessionsIntoSystemHome,
    runCodexSessionIndexHeal: heal.runCodexSessionIndexHeal
  }
}
