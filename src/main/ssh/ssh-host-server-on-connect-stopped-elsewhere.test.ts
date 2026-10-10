import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { recheckFencedManagedServer } from './managed-server-fence-recheck'
import {
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { planManagedOrcadAutoUpdate } from './orcad-managed-auto-update'
import { compareAppVersions } from '../../shared/app-version'
import {
  MANAGED_ORCAD_FENCED_DETAIL,
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
} from './orcad-managed-serving'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const notActivated = vi.fn(async () => ({
  state: 'unverifiable' as const,
  detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
}))

describe('a linked server another desktop stopped (P1-D)', () => {
  it('is redeployed through the update on connect instead of staying stranded', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: notActivated,
      autoUpdate: vi.fn(async (_id, options) => {
        options.onUpdating()
        return { outcome: 'updated' as const, activeVersion: '2' }
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9'
    })
    expect(d.autoUpdate).toHaveBeenCalledWith('env-9', expect.anything())
    expect(d.progress).toHaveBeenCalledWith(target, 'updating')
    expect(d.relayTerminals).not.toHaveBeenCalled()
  })

  it('keeps the not-activated note when the redeploy did not run', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: notActivated,
      autoUpdate: vi.fn(async () => ({ outcome: 'failed' as const, reason: 'upload failed' }))
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9',
      update: { state: 'failed', detail: 'upload failed' },
      serving: { state: 'unverifiable', detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL }
    })
  })

  it('still skips the update for a server that is unverifiable for any other reason', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: vi.fn(async () => ({
        state: 'unverifiable' as const,
        detail: MANAGED_ORCAD_FENCED_DETAIL
      }))
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toMatchObject({
      fenceHeld: true
    })
    expect(d.autoUpdate).not.toHaveBeenCalled()
  })

  it('is redeployed by the fence recheck too', async () => {
    const d = hostServerDepsStub({
      ensureServing: notActivated,
      autoUpdate: vi.fn(async () => ({ outcome: 'updated' as const, activeVersion: '2' }))
    })
    await expect(recheckFencedManagedServer(target, 'env-9', d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9'
    })
  })

  it('plans an update for the record a stop leaves behind', () => {
    const served: OrcadActivationRecord = {
      schemaVersion: 1,
      active: '1.0.0+abc',
      previous: null,
      activatedAt: '2026-10-01T00:00:00.000Z',
      activeAppVersion: '1.0.0',
      snapshot: null
    }
    expect(
      planManagedOrcadAutoUpdate({
        record: withDeactivatedVersionCommitted(served),
        candidateVersion: '1.0.0+abc',
        appVersion: '1.0.0',
        failedBefore: false
      })
    ).toEqual({ action: 'update' })
  })
})

describe('redeploying a host another desktop stopped, across Orca versions', () => {
  const servedBy = (appVersion: string, active: string): OrcadActivationRecord => ({
    schemaVersion: 1,
    active,
    previous: null,
    activatedAt: '2026-10-01T00:00:00.000Z',
    activeAppVersion: appVersion,
    snapshot: null
  })
  const plan = (record: OrcadActivationRecord, appVersion: string, failedBefore = false) =>
    planManagedOrcadAutoUpdate({
      record,
      candidateVersion: `${appVersion}+cand`,
      appVersion,
      failedBefore
    })

  it('never lets an older desktop downgrade a host a newer desktop stopped', () => {
    const stopped = withDeactivatedVersionCommitted(servedBy('1.5.0', '1.5.0+new'))
    expect(plan(stopped, '1.4.0')).toEqual({ action: 'skip', reason: 'host-newer' })
    expect(plan(stopped, '1.5.0')).toEqual({ action: 'update' })
    expect(plan(stopped, '1.6.0')).toEqual({ action: 'update' })
  })

  it('keeps released desktops, which plan on activeAppVersion alone, from downgrading it', () => {
    // Frozen copy of the planner shipped before stopped hosts had their own policy.
    const releasedPlan = (record: OrcadActivationRecord, appVersion: string): string =>
      record.activeAppVersion && compareAppVersions(record.activeAppVersion, appVersion) > 0
        ? 'host-newer'
        : 'update'
    const stopped = withDeactivatedVersionCommitted(servedBy('1.5.0', '1.5.0+new'))
    expect(releasedPlan(stopped, '1.4.0')).toBe('host-newer')
    expect(releasedPlan(stopped, '1.5.0')).toBe('update')
  })

  it('redeploys a stop recorded without the app version', () => {
    // What a stop committed by a build that predates keeping the app version leaves.
    const legacy = withDeactivatedVersion(servedBy('1.5.0', '1.5.0+new'))
    expect(plan(legacy, '1.6.0')).toEqual({ action: 'update' })
    expect(plan(legacy, '1.4.0')).toEqual({ action: 'update' })
    expect(plan(legacy, '1.4.0', true)).toEqual({ action: 'update' })
  })

  it('retries the redeploy after an earlier failure, since nothing serves', () => {
    const stopped = withDeactivatedVersionCommitted(servedBy('1.4.0', '1.4.0+old'))
    expect(plan(stopped, '1.4.0', true)).toEqual({ action: 'update' })
    // A host that still serves keeps the once-per-version suppression.
    expect(plan(servedBy('1.4.0', '1.4.0+old'), '1.5.0', true)).toEqual({
      action: 'skip',
      reason: 'failed-before'
    })
  })

  it('never reactivates a build an explicit rollback left, after a stop', () => {
    const rolledBack = { ...servedBy('1.5.0', '1.5.0+old'), rolledBackFrom: '1.5.0+cand' }
    expect(plan(withDeactivatedVersionCommitted(rolledBack), '1.5.0')).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
  })
})
