import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { acquireOrcadInstanceLock } from '../orcad/instance-lock/orcad-instance-lock'
import { agentSessionRecordStoreHostServing } from '../runtime/agent-session/records/agent-session-record-store-serving'
import {
  prepareAntigravityReplyOnlyLaunch,
  sweepAntigravityReplyOnlyHomes
} from './antigravity-reply-only-home'
import { isDirectVerifiedChild } from './antigravity-reply-only-root'

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

function userHomeEnv(userHome: string): Record<string, string> {
  return { HOME: userHome, USERPROFILE: userHome }
}

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  folders.push(path)
  return path
}

function geminiDirFromArgs(args: readonly string[]): string {
  const index = args.indexOf('--gemini-dir')
  expect(index).toBeGreaterThan(-1)
  return args[index + 1]
}

describe('isDirectVerifiedChild Windows path containment', () => {
  it('accepts valid Windows drive, casing, UNC, and extended-length direct children while rejecting escapes', () => {
    const run = 'run-12345678-1234-4123-8123-123456789abc'
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\AppData\\Roaming\\Orca\\acp-reply-only\\antigravity',
        `C:\\Users\\alice\\AppData\\Roaming\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(true)
    expect(
      isDirectVerifiedChild(
        'c:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\',
        `C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\${run.toUpperCase()}\\`,
        run,
        'win32'
      )
    ).toBe(true)
    expect(
      isDirectVerifiedChild(
        '\\\\server\\share\\Orca\\acp-reply-only\\antigravity',
        `\\\\server\\share\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(true)
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        `\\\\?\\C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(true)
    expect(
      isDirectVerifiedChild(
        '\\\\?\\UNC\\server\\share\\Orca\\acp-reply-only\\antigravity',
        `\\\\server\\share\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(true)

    // Cross-drive, different UNC share, parent escape, nested child, sibling mismatch, and equal path must all fail closed.
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        `D:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(false)
    expect(
      isDirectVerifiedChild(
        '\\\\server\\share\\Orca\\acp-reply-only\\antigravity',
        `\\\\other\\share\\Orca\\acp-reply-only\\antigravity\\${run}`,
        run,
        'win32'
      )
    ).toBe(false)
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        `C:\\Users\\alice\\Orca\\other\\${run}`,
        run,
        'win32'
      )
    ).toBe(false)
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        `C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\nested\\${run}`,
        run,
        'win32'
      )
    ).toBe(false)
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        run,
        'win32'
      )
    ).toBe(false)
    expect(
      isDirectVerifiedChild(
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity',
        'C:\\Users\\alice\\Orca\\acp-reply-only\\antigravity\\run-other',
        run,
        'win32'
      )
    ).toBe(false)
  })
})

describe('Antigravity reply-only symlink containment and startup sweep', () => {
  it('refuses symlinked acp-reply-only or antigravity parents during prepare and sweep without mutating targets', async () => {
    const userHome = tempDir('agy-symlink-user-')

    const dataWithLinkedParent = tempDir('agy-symlink-parent-data-')
    const parentTarget = tempDir('agy-symlink-parent-target-')
    const parentTargetAgy = join(parentTarget, 'antigravity')
    const victimRunName = 'run-00000000-0000-4000-8000-000000000001'
    const parentTargetRun = join(parentTargetAgy, victimRunName)
    mkdirSync(parentTargetRun, { recursive: true })
    writeFileSync(join(parentTargetAgy, 'sentinel.txt'), 'do-not-delete')
    writeFileSync(join(parentTargetRun, 'secret.txt'), 'keep')
    symlinkSync(
      parentTarget,
      join(dataWithLinkedParent, 'acp-reply-only'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      prepareAntigravityReplyOnlyLaunch({
        mode: 'reply-only',
        dataDirectory: dataWithLinkedParent,
        env: userHomeEnv(userHome)
      })
    ).rejects.toThrow(/symlinked|non-directory|redirected/i)
    await expect(sweepAntigravityReplyOnlyHomes(dataWithLinkedParent)).rejects.toThrow(
      /symlinked|non-directory|redirected/i
    )
    expect(readFileSync(join(parentTargetAgy, 'sentinel.txt'), 'utf8')).toBe('do-not-delete')
    expect(readFileSync(join(parentTargetRun, 'secret.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(parentTargetAgy).sort()).toEqual([victimRunName, 'sentinel.txt'])

    const dataWithLinkedAgent = tempDir('agy-symlink-agent-data-')
    const agentTarget = tempDir('agy-symlink-agent-target-')
    const agentTargetRun = join(agentTarget, victimRunName)
    mkdirSync(agentTargetRun, { recursive: true })
    writeFileSync(join(agentTarget, 'sentinel.txt'), 'do-not-delete')
    writeFileSync(join(agentTargetRun, 'secret.txt'), 'keep')
    mkdirSync(join(dataWithLinkedAgent, 'acp-reply-only'), { recursive: true })
    symlinkSync(
      agentTarget,
      join(dataWithLinkedAgent, 'acp-reply-only', 'antigravity'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      prepareAntigravityReplyOnlyLaunch({
        mode: 'reply-only',
        dataDirectory: dataWithLinkedAgent,
        env: userHomeEnv(userHome)
      })
    ).rejects.toThrow(/symlinked|non-directory|redirected/i)
    await expect(sweepAntigravityReplyOnlyHomes(dataWithLinkedAgent)).rejects.toThrow(
      /symlinked|non-directory|redirected/i
    )
    expect(readFileSync(join(agentTarget, 'sentinel.txt'), 'utf8')).toBe('do-not-delete')
    expect(readFileSync(join(agentTargetRun, 'secret.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(agentTarget).sort()).toEqual([victimRunName, 'sentinel.txt'])
  })

  it('refuses release when parent or run directory was swapped for a symlink and preserves target', async () => {
    const userHome = tempDir('agy-release-symlink-user-')

    // Subcase 1: run directory swapped to a symlink pointing outside the root.
    const data1 = tempDir('agy-release-symlink-run-data-')
    const prepared1 = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory: data1,
      env: userHomeEnv(userHome)
    })
    const runDir1 = geminiDirFromArgs(prepared1.args)
    const runName1 = basename(runDir1)
    const victim1 = tempDir('agy-release-victim-1-')
    writeFileSync(join(victim1, 'precious.txt'), 'intact')
    rmSync(runDir1, { recursive: true, force: true })
    symlinkSync(victim1, runDir1, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(prepared1.release()).rejects.toThrow(/symlinked|non-directory|redirected/i)
    expect(readFileSync(join(victim1, 'precious.txt'), 'utf8')).toBe('intact')

    // Subcase 2: intermediate acp-reply-only directory swapped to a symlink pointing at a victim tree.
    const data2 = tempDir('agy-release-symlink-parent-data-')
    const prepared2 = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory: data2,
      env: userHomeEnv(userHome)
    })
    const runDir2 = geminiDirFromArgs(prepared2.args)
    const runName2 = basename(runDir2)
    expect(runName2).not.toBe(runName1)
    const victim2 = tempDir('agy-release-victim-2-')
    const victimRun2 = join(victim2, 'antigravity', runName2)
    mkdirSync(victimRun2, { recursive: true })
    writeFileSync(join(victimRun2, 'precious.txt'), 'intact')
    const backupParent = join(data2, 'acp-reply-only-backup')
    renameSync(join(data2, 'acp-reply-only'), backupParent)
    symlinkSync(
      victim2,
      join(data2, 'acp-reply-only'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(prepared2.release()).rejects.toThrow(/symlinked|non-directory|redirected/i)
    expect(readFileSync(join(victimRun2, 'precious.txt'), 'utf8')).toBe('intact')
  })

  it('sweeps crash-abandoned UUID reply-only runs and OAuth copies on host startup while keeping active runs, non-UUID run-* dirs, unrelated entries, and symlink targets intact', async () => {
    const dataDirectory = tempDir('agy-startup-sweep-data-')
    const userHome = tempDir('agy-startup-sweep-user-')
    const canonicalDataDir = realpathSync(dataDirectory)
    const root = join(canonicalDataDir, 'acp-reply-only', 'antigravity')

    // Simulate a crash-abandoned UUID run directory with a file-backed OAuth credential copy.
    const abandonedRun = join(root, 'run-12345678-1234-4123-8123-123456789abc')
    const abandonedAppData = join(abandonedRun, ANTIGRAVITY_ACP_HOME)
    mkdirSync(abandonedAppData, { recursive: true })
    mkdirSync(join(abandonedRun, 'work'), { recursive: true })
    writeFileSync(
      join(abandonedAppData, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'leaked-oauth-token' })
    )

    // Non-UUID run-* directory, unrelated file/directory, and a UUID-named symlink inside the root.
    const manualBackupDir = join(root, 'run-manual-backup')
    mkdirSync(manualBackupDir, { recursive: true })
    writeFileSync(join(manualBackupDir, 'backup.txt'), 'preserve-manual-backup')
    writeFileSync(join(root, 'keep-note.txt'), 'keep-me')
    const unrelatedDir = join(root, 'custom-folder')
    mkdirSync(unrelatedDir, { recursive: true })
    writeFileSync(join(unrelatedDir, 'data.txt'), 'keep-folder')
    const symlinkVictim = tempDir('agy-sweep-run-symlink-victim-')
    writeFileSync(join(symlinkVictim, 'target.txt'), 'do-not-delete')
    symlinkSync(
      symlinkVictim,
      join(root, 'run-11111111-1111-4111-8111-111111111111'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    // Also hold one live/active run in this process to verify startup sweep never removes it.
    const active = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory,
      env: userHomeEnv(userHome)
    })
    const activeRunDir = geminiDirFromArgs(active.args)

    const lock = acquireOrcadInstanceLock(dataDirectory, {
      role: 'desktop',
      machineIdentity: () => 'temporary-test-machine',
      startedAtMs: () => null,
      incarnation: () => null
    })
    try {
      const openStore = vi.fn().mockResolvedValue(undefined)
      const startWatches = vi.fn()
      agentSessionRecordStoreHostServing(
        {
          openAgentSessionRecordStore: openStore,
          startPullRequestWatches: startWatches
        },
        dataDirectory
      )

      await vi.waitFor(() => {
        expect(existsSync(abandonedRun)).toBe(false)
      })
      expect(existsSync(join(abandonedAppData, 'antigravity-oauth-token'))).toBe(false)
      expect(existsSync(activeRunDir)).toBe(true)
      expect(existsSync(active.cwd)).toBe(true)
      expect(readFileSync(join(manualBackupDir, 'backup.txt'), 'utf8')).toBe(
        'preserve-manual-backup'
      )
      expect(readFileSync(join(root, 'keep-note.txt'), 'utf8')).toBe('keep-me')
      expect(readFileSync(join(unrelatedDir, 'data.txt'), 'utf8')).toBe('keep-folder')
      expect(readFileSync(join(symlinkVictim, 'target.txt'), 'utf8')).toBe('do-not-delete')
    } finally {
      lock.release()
      await active.release()
    }
    expect(existsSync(activeRunDir)).toBe(false)
  })

  it('skips startup sweep when profile ownership is not held and sweeps once this host owns the profile lock', async () => {
    const unlockedDataDir = tempDir('agy-sweep-unlocked-data-')
    const unlockedRun = join(
      realpathSync(unlockedDataDir),
      'acp-reply-only',
      'antigravity',
      'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    mkdirSync(unlockedRun, { recursive: true })
    writeFileSync(join(unlockedRun, 'active-elsewhere.txt'), 'keep-while-unowned')

    const ownedDataDir = tempDir('agy-sweep-owned-data-')
    const ownedRun = join(
      realpathSync(ownedDataDir),
      'acp-reply-only',
      'antigravity',
      'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    mkdirSync(ownedRun, { recursive: true })
    writeFileSync(join(ownedRun, 'stale.txt'), 'remove-when-owned')

    const servingRuntime = {
      openAgentSessionRecordStore: vi.fn().mockResolvedValue(undefined),
      startPullRequestWatches: vi.fn()
    }

    // Without owning unlockedDataDir's profile lock, serving must NOT sweep it.
    agentSessionRecordStoreHostServing(servingRuntime, unlockedDataDir)

    // Run a real owned sweep as a completion fence so any unguarded sweep would have run too.
    const ownedLock = acquireOrcadInstanceLock(ownedDataDir, {
      machineIdentity: () => 'temporary-test-machine',
      startedAtMs: () => null,
      incarnation: () => null
    })
    try {
      agentSessionRecordStoreHostServing(servingRuntime, ownedDataDir)
      await vi.waitFor(() => {
        expect(existsSync(ownedRun)).toBe(false)
      })
    } finally {
      ownedLock.release()
    }
    expect(readFileSync(join(unlockedRun, 'active-elsewhere.txt'), 'utf8')).toBe(
      'keep-while-unowned'
    )

    // Once this host acquires the profile lock for unlockedDataDir, startup serving sweeps it.
    const acquiredLock = acquireOrcadInstanceLock(unlockedDataDir, {
      machineIdentity: () => 'temporary-test-machine',
      startedAtMs: () => null,
      incarnation: () => null
    })
    try {
      agentSessionRecordStoreHostServing(servingRuntime, unlockedDataDir)
      await vi.waitFor(() => {
        expect(existsSync(unlockedRun)).toBe(false)
      })
    } finally {
      acquiredLock.release()
    }
  })
})
