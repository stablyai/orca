import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { Automation } from '../../shared/automations-types'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
import { startedAutomationService, tickAt } from './automation-service-tick.test-fixture'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// Runtime-owned target IDs can repeat across registrations.
const TARGET_ID = 'runtime-ssh-recipe-1'

const REPLACED =
  'The automation host was removed and re-registered, so this automation must be re-adopted before it can run.'

function sshTarget(generation: number | undefined): SshTarget {
  return {
    id: TARGET_ID,
    label: 'devbox',
    host: 'devbox.internal',
    port: 22,
    username: 'orca',
    ...(generation === undefined ? {} : { generation })
  }
}

function seedSshAutomation(store: Store, options: { capture?: boolean } = {}): Automation {
  store.addSshTarget(sshTarget(options.capture === false ? undefined : 1))
  store.addRepo({
    id: 'r1',
    path: '/repo',
    displayName: 'test',
    badgeColor: '#fff',
    addedAt: 1,
    connectionId: TARGET_ID
  } as Repo)
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
}

function reRegisterTarget(store: Store): void {
  store.removeSshTarget(TARGET_ID)
  store.addSshTarget(sshTarget(store.allocateSshTargetGeneration()))
}

async function evaluateAt(store: Store, automationId: string, when: string): Promise<void> {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === automationId)?.nextRunAt
  const before = nextRunAt()
  await tickAt(when)
  await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before ?? 0))
}

describe('scheduled dispatch fenced on the host the record captured', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-dispatch-fence-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('refuses the run once the same id carries a new registration', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const launch = vi.fn(async () => ({ workspaceId: 'wt-1', terminalSessionId: 'tab-1' }))
    const service = startedAutomationService(store, launch)
    reRegisterTarget(store)

    await evaluateAt(store, automation.id, '2026-05-13T09:01:00')
    service.stop()

    expect(launch).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: REPLACED
    })
  })

  // #29083: the host's server owns its automations once a move fences it.
  it('writes nothing for a host a move fenced, and resumes when the fence is released', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const launch = vi.fn(async () => ({ workspaceId: 'wt-1', terminalSessionId: 'tab-1' }))
    const service = startedAutomationService(store, launch)
    store.updateSshTarget(TARGET_ID, { orcadFence: { environmentId: 'env-1' } })
    const before = store.listAutomations()[0]

    await tickAt('2026-05-13T09:01:00')
    await expect(service.runNow(automation.id)).rejects.toThrow(
      "This automation now runs on its SSH host's Orca server."
    )
    await service.recordRefusedRun(automation.id)

    expect(launch).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(store.listAutomations()[0]).toEqual(before)

    store.updateSshTarget(TARGET_ID, { orcadFence: undefined })
    await evaluateAt(store, automation.id, '2026-05-13T09:02:00')

    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
  })
})
