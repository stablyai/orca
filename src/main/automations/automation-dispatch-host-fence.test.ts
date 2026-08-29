/**
 * Removing a host — or removing and re-registering it under the same id — leaves
 * hostId, repoId and path untouched, so every other run-target check still passes
 * while the host is gone or is a different machine. The list already calls both
 * records orphans; without this fence the scheduler keeps firing them anyway.
 *
 * What must keep dispatching is the record whose scheduler lives on a remote
 * server: the list files it as an orphan too, and on that server it is exactly
 * what the scheduler exists to run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { Automation } from '../../shared/automations-types'
import { AUTOMATION_ORPHAN_ISSUES } from '../../shared/automation-list-scope'
import type { Store } from '../persistence'
import { resolveAutomationRunTarget } from './run-target-resolution'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

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

async function createStore(): Promise<Store> {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store: StoreClass, initDataPath } = await import('../persistence')
  initDataPath()
  return new StoreClass()
}

/** The reachable shape: a runtime-owned id is derived, not minted per lifecycle. */
const TARGET_ID = 'runtime-ssh-recipe-1'

const REPLACED =
  'The automation host was removed and re-registered, so this automation must be re-adopted before it can run.'

const MISSING =
  'The automation host is no longer registered, so this automation has nowhere to run.'

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

/** Daily at 09:00 on an SSH host, with whatever generation that host currently has. */
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

/** A second record refused for a different reason, to prove the two never collide. */
function seedMissingSetupAutomation(store: Store): Automation {
  store.addRepo({
    id: 'r2',
    path: '/other',
    displayName: 'other',
    badgeColor: '#fff',
    addedAt: 1
  } as Repo)
  const automation = store.createAutomation({
    name: 'Other check',
    prompt: 'Check the other repo',
    agentId: 'claude',
    projectId: 'r2',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
  // Drift after storage: the setup the record captured no longer exists. The
  // create path derives contexts itself, so the drifted record is built here.
  return {
    ...automation,
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-2',
      hostId: 'local',
      projectHostSetupId: 'missing-setup',
      repoId: 'r2',
      path: '/other'
    }
  }
}

/**
 * The record a remote server's own scheduler owns. The list files it
 * `orphan(scheduledElsewhere)`, so a blanket orphan refusal would stop remote
 * scheduling everywhere it is the point of the feature.
 */
function seedRemoteScheduledAutomation(store: Store): Automation {
  store.addRepo({
    id: 'r3',
    path: '/remote',
    displayName: 'remote',
    badgeColor: '#fff',
    addedAt: 1,
    executionHostId: 'runtime:vm-1'
  } as Repo)
  return store.createAutomation({
    name: 'Remote check',
    prompt: 'Check the remote repo',
    agentId: 'claude',
    projectId: 'r3',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
}

/** Remove then re-register under the same id — the only way a generation advances. */
function reRegisterTarget(store: Store): void {
  store.removeSshTarget(TARGET_ID)
  store.addSshTarget(sshTarget(store.allocateSshTargetGeneration()))
}

function attachedService(store: Store): {
  service: AutomationService
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const service = new AutomationService(store, { tickMs: 60_000 })
  service.setWebContents({ isDestroyed: () => false, send } as never)
  return { service, send }
}

/** One scheduler pass. `nextRunAt` advancing is the signal that it finished. */
async function evaluateAt(
  store: Store,
  service: AutomationService,
  automationId: string,
  when: string
): Promise<void> {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === automationId)?.nextRunAt
  const before = nextRunAt()
  vi.setSystemTime(new Date(when))
  service.setRendererReady()
  await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before ?? 0))
}

describe('scheduled dispatch fenced on the host the record captured', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-dispatch-fence-test-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses the run once the same id carries a new registration', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const { service, send } = attachedService(store)
    reRegisterTarget(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: REPLACED
    })
  })

  it('refuses the run once its host is gone entirely', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const { service, send } = attachedService(store)
    store.removeSshTarget(TARGET_ID)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: MISSING
    })
  })

  // The trap a blanket orphan refusal would fall into: on a serve-mode host these
  // records are the whole feature, and the list calls every one of them an orphan.
  it('still dispatches a record whose scheduler lives on a remote server', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedRemoteScheduledAutomation(store)
    const send = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true
    })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    expect(automation.schedulerOwner).toBe('remote_host_service')
    expect(
      store.listAutomationsForScope().items.find((entry) => entry.automationId === automation.id)
        ?.selector
    ).toEqual({ kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere })

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.anything())
  })

  // The whole point of the fence: one verdict, so the two can't drift apart.
  it('refuses exactly the record the list files as an orphan', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    reRegisterTarget(store)

    const item = store
      .listAutomationsForScope()
      .items.find((entry) => entry.automationId === automation.id)

    expect(item?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })

  it('dispatches while the registration the record captured is still the live one', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const { service, send } = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.anything())
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
  })

  // Absent is not mismatched: fencing these would silently stop every record
  // written before generations existed.
  it('dispatches a record that captured no generation at all', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store, { capture: false })
    // The migration stamps the target long after the record was written.
    store.updateSshTarget(TARGET_ID, { generation: store.allocateSshTargetGeneration() })
    const { service, send } = attachedService(store)

    expect(automation.executionTargetGeneration).toBeUndefined()
    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.anything())
  })

  // A missing run context resolves from bare repo state, which survives the host
  // being replaced — so the legacy path must consult the same verdict.
  it('refuses a legacy record with no run context once its host was replaced', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    store.updateAutomation(
      automation.id,
      { runContext: null },
      { expectedOwner: store.automationOwnerPrecondition(automation.id) ?? undefined }
    )
    const { service, send } = attachedService(store)
    reRegisterTarget(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(send).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: REPLACED
    })
  })

  // The fold in #26 keys on byte-identical error text. A generation number, a host
  // label or a timestamp in this message would defeat it and restore one row per
  // occurrence; colliding with another diagnosis would merge two of them.
  it('refuses in bytes that neither vary nor collide with another skip reason', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const other = seedMissingSetupAutomation(store)

    reRegisterTarget(store)
    const first = resolveAutomationRunTarget(store, automation)
    reRegisterTarget(store)
    const second = resolveAutomationRunTarget(store, automation)

    expect(first).toEqual({ ok: false, error: REPLACED })
    // Two different live generations, one string: nothing per-occurrence leaked in.
    expect(second).toEqual(first)
    expect(resolveAutomationRunTarget(store, other)).toEqual({
      ok: false,
      error: 'Project is not set up on the selected automation host anymore.'
    })
    // A gone host and a replaced one are different diagnoses and must never fold together.
    store.removeSshTarget(TARGET_ID)
    expect(resolveAutomationRunTarget(store, automation)).toEqual({ ok: false, error: MISSING })
  })

  // Composes with the coalescing from #26 rather than fighting it: a refusal the
  // user cannot fix from the host side must not write one row per occurrence.
  it('folds repeated refusals into a single record', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedSshAutomation(store)
    const { service } = attachedService(store)
    reRegisterTarget(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-15T09:01:00')

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ error: REPLACED, occurrenceCount: 3 })
  })
})
