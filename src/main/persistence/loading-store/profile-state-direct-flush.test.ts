import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexResetCreditAttemptLedger } from '../../../shared/codex-reset-credit-attempt-ledger'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { readProfileStateDomain } from '../profile-state/profile-state-domain-reader'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { Store } from './store'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const PROFILE_ID = 'direct-flush-test'
const fixtures: { directory: string; store: Store }[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.freezeWrites()
    await fixture.store.flushAsync()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function fixture(seedState?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-direct-flush-'))
  const databasePath = join(directory, 'profile-state.db')
  const authority = new ProfileStateSqliteAuthority(databasePath, PROFILE_ID)
  vi.spyOn(authority, 'scheduleBackup').mockImplementation(() => {})
  if (seedState !== undefined) {
    authority.writeSerializedState(Buffer.from(JSON.stringify(seedState)))
  }
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  fixtures.push({ directory, store })
  store.flushOrThrow()
  return {
    store,
    read: (domain: string) => readProfileStateDomain(databasePath, PROFILE_ID, domain),
    pendSession: () => store.patchWorkspaceSession({ activeWorktreeId: 'pending-workspace' })
  }
}

describe('SQLite durability barriers with another selective write pending', () => {
  it('commits a reset-credit claim before returning to its provider caller', async () => {
    const state = fixture()
    const ledger: CodexResetCreditAttemptLedger = {
      version: 1,
      attempts: [
        {
          idempotencyKey: '158a0d86-8d8e-4589-b9c5-f53a59bdcdd8',
          expectedScope: {
            target: { runtime: 'host', wslDistro: null },
            accountId: 'account',
            accountRevision: 1,
            offerRevision: 'v1:offer'
          },
          state: 'providerPending'
        }
      ]
    }
    state.pendSession()
    await state.store.replaceCodexResetCreditAttemptLedgerAndFlush(ledger)
    expect(state.read('codexResetCreditAttemptLedger')).toMatchObject({
      kind: 'value',
      value: ledger
    })
  })

  it('commits Claude live-PTY admission before returning', () => {
    const state = fixture()
    state.pendSession()
    state.store.addClaudeLivePtySessionId('claude-session')
    expect(state.read('claudeLivePtySessionIds')).toMatchObject({
      kind: 'value',
      value: ['claude-session']
    })
  })

  it('commits SSH lease admission before returning', () => {
    const state = fixture()
    state.pendSession()
    state.store.upsertSshRemotePtyLease({ targetId: 'ssh-test', ptyId: 'pty-1', state: 'attached' })
    expect(state.read('sshRemotePtyLeases')).toMatchObject({
      kind: 'value',
      value: [{ targetId: 'ssh-test', ptyId: 'pty-1', state: 'attached' }]
    })
  })

  it.each(['async', 'shutdown'] as const)(
    'persists SSH detachment through the %s barrier',
    async (barrier) => {
      const state = fixture()
      state.store.upsertSshRemotePtyLease({
        targetId: 'ssh-test',
        ptyId: 'pty-1',
        state: 'attached'
      })
      state.pendSession()
      if (barrier === 'async') {
        await state.store.markSshRemotePtyLeasesAsync('ssh-test', 'detached')
      } else {
        state.store.markSshRemotePtyLeasesForShutdown('ssh-test', 'detached')
        await state.store.flushAsync()
      }
      expect(state.read('sshRemotePtyLeases')).toMatchObject({
        kind: 'value',
        value: [{ targetId: 'ssh-test', ptyId: 'pty-1', state: 'detached' }]
      })
    }
  )

  it('persists sealed SSH consumer recovery before relay setup continues', async () => {
    const state = fixture()
    state.pendSession()
    await state.store.upsertSshPtyConsumerRecovery({
      targetId: 'ssh-test',
      clientInstanceId: 'client-test',
      serverBuildId: 'build-test',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'secret-owner-lease'
    })
    const stored = state.read('sshPtyConsumerRecoveries')
    expect(stored).toMatchObject({ kind: 'value', value: [{ targetId: 'ssh-test' }] })
    expect(JSON.stringify(stored)).not.toContain('secret-owner-lease')
    state.pendSession()
    await state.store.removeSshPtyConsumerRecovery('ssh-test')
    expect(state.read('sshPtyConsumerRecoveries')).toMatchObject({ kind: 'value', value: [] })
  })

  it('deletes an automation and its retained runs in the same commit', () => {
    const state = fixture(buildProfileStateCutoverFixture())
    const automation = state.store.listAutomations()[0]
    if (!automation) {
      throw new Error('Fixture automation is absent')
    }
    expect(state.store.listAutomationRuns(automation.id)).not.toHaveLength(0)
    state.store.deleteAutomation(automation.id)
    expect(state.read('automations')).toMatchObject({ kind: 'value', value: [] })
    expect(state.read('automationRuns')).toMatchObject({ kind: 'value', value: [] })
  })

  it('persists the session and UI identities moved with worktree metadata', () => {
    const seed = buildProfileStateCutoverFixture()
    const oldId = 'repo-local::/fixture/local'
    const newId = 'repo-local::/fixture/renamed'
    seed.workspaceSession.activeWorktreeId = oldId
    seed.ui.showDotfilesByWorktree = { [oldId]: true }
    const state = fixture(seed)
    state.store.migrateWorktreeIdentity(oldId, newId)
    state.store.flushOrThrow()
    expect(state.read('workspaceSession')).toMatchObject({
      kind: 'value',
      value: { activeWorktreeId: newId }
    })
    expect(state.read('ui')).toMatchObject({
      kind: 'value',
      value: { showDotfilesByWorktree: { [newId]: true } }
    })
  })
})
