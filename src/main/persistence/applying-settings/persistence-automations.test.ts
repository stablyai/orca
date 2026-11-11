import { closeTestStores, testState, createStore, makeRepo } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('returns the existing automation for a repeated creation key', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const input = {
      creationKey: 'move-retry-1',
      name: 'Retry-safe move',
      prompt: 'Run checks',
      agentId: 'claude' as const,
      projectId: 'r1',
      workspaceMode: 'new_per_run' as const,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    }

    const first = store.createAutomation(input)
    const retry = store.createAutomation({ ...input, name: 'Changed by a retry' })

    expect(retry.id).toBe(first.id)
    expect(store.listAutomations()).toHaveLength(1)
  })

  it('treats undefined update fields as omitted, never as explicit clears', async () => {
    // Renderer patches can carry explicit undefined for untouched fields; only null clears them.
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      baseBranch: 'origin/release',
      setupDecision: 'run',
      precheck: { command: 'pnpm lint', timeoutSeconds: 30 },
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, {
      precheck: undefined,
      runContext: undefined,
      sourceContext: undefined,
      baseBranch: undefined,
      setupDecision: undefined
    })

    expect(updated.precheck).toEqual(automation.precheck)
    expect(updated.runContext).toEqual(automation.runContext)
    expect(updated.sourceContext).toEqual(automation.sourceContext)
    expect(updated.baseBranch).toBe('origin/release')
    expect(updated.setupDecision).toBe('run')
    expect(store.updateAutomation(automation.id, { baseBranch: null }).baseBranch).toBeNull()

    const existing = store.updateAutomation(automation.id, {
      workspaceMode: 'existing',
      workspaceId: 'wt1'
    })
    expect(store.updateAutomation(existing.id, { workspaceId: undefined }).workspaceId).toBe('wt1')
  })

  it('stores its own contexts over a client-perspective create runContext', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))

    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime(),
      // Client-assigned runtime IDs have no meaning in the owning host’s namespace.
      runContext: {
        kind: 'workspace-run',
        projectId: 'github:stablyai/orca',
        hostId: toRuntimeExecutionHostId('client-env'),
        projectHostSetupId: 'client-setup',
        repoId: 'client-repo',
        path: '/client/checkout'
      }
    })

    expect(automation.runContext).toMatchObject({ hostId: 'local', repoId: 'r1' })
    expect(store.listAutomationsForScope().items[0]?.selector).toEqual({ kind: 'self' })
  })

  it("deleting an SSH twin's workspace leaves the local twin's run label", async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const before = store.listAutomationRuns(automation.id)[0].workspaceDisplayName

    const updatedCount = store.snapshotAutomationRunWorkspaceDisplayName(
      hostWorktreeTarget({ id: 'wt1', hostId: toSshExecutionHostId('ssh-1') }),
      'SSH twin'
    )

    expect(updatedCount).toBe(0)
    expect(store.listAutomationRuns(automation.id)[0].workspaceDisplayName).toBe(before)
  })

  it('persists automation run output snapshots across later status updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      terminalPaneKey: paneKey,
      terminalPtyId: 'pty-run',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Run finished',
        capturedAt: 1,
        truncated: false
      },
      error: null
    })
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      usage: null,
      completionAttribution: {
        kind: 'exact_provider_session',
        provider: 'claude',
        providerSessionKey: 'session_id',
        providerSessionId: 'sess-primary',
        terminalPtyId: 'pty-run',
        terminalPaneKey: paneKey
      },
      error: null
    })

    const persisted = store.listAutomationRuns(automation.id)[0]
    expect(persisted.outputSnapshot).toMatchObject({
      content: 'Run finished',
      truncated: false
    })
    expect(persisted).toMatchObject({
      terminalSessionId: 'tab-1',
      terminalPaneKey: paneKey,
      terminalPtyId: 'pty-run',
      completionAttribution: {
        kind: 'exact_provider_session',
        provider: 'claude',
        providerSessionKey: 'session_id',
        providerSessionId: 'sess-primary',
        terminalPtyId: 'pty-run',
        terminalPaneKey: paneKey
      }
    })
  })
})
