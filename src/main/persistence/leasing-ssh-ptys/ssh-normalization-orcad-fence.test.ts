import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { normalizeSshTarget } from './ssh-normalization'

const base: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

describe('loading a managed Orca server fence', () => {
  it('moves a phase-3 owner fence to orcadFence, so shipped builds stop hiding the host', () => {
    const loaded = normalizeSshTarget({
      ...base,
      owner: { type: 'on-demand-runtime', runtimeId: 'managed-orcad:env-1' }
    })
    expect(loaded.owner).toBeUndefined()
    expect(loaded.orcadFence).toEqual({ environmentId: 'env-1' })
  })

  it('keeps ephemeral runtime owners, a valid fence, and drops a malformed one', () => {
    const vm = normalizeSshTarget({
      ...base,
      owner: { type: 'on-demand-runtime', runtimeId: 'vm' }
    })
    expect(vm.owner).toEqual({ type: 'on-demand-runtime', runtimeId: 'vm' })
    expect(
      normalizeSshTarget({
        ...base,
        orcadFence: { environmentId: 'env-1', sourceChangedAt: '2026-10-05T00:00:00.000Z' }
      }).orcadFence
    ).toEqual({ environmentId: 'env-1', sourceChangedAt: '2026-10-05T00:00:00.000Z' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a hand-edited or corrupt stored fence.
    const malformed = { ...base, orcadFence: { environmentId: 7 } } as unknown as SshTarget
    expect(normalizeSshTarget(malformed).orcadFence).toBeUndefined()
  })

  it('keeps the recorded move offer and drops a malformed one', () => {
    expect(
      normalizeSshTarget({ ...base, managedServerMoveOffered: { appVersion: '1.5.0' } })
        .managedServerMoveOffered
    ).toEqual({ appVersion: '1.5.0' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a hand-edited or corrupt stored record.
    const malformed = {
      ...base,
      managedServerMoveOffered: { appVersion: 7 }
    } as unknown as SshTarget
    expect(normalizeSshTarget(malformed).managedServerMoveOffered).toBeUndefined()
  })

  it('falls back to the legacy owner when the stored fence is malformed', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a corrupt fence next to a legacy owner.
    const loaded = normalizeSshTarget({
      ...base,
      owner: { type: 'on-demand-runtime', runtimeId: 'managed-orcad:env-1' },
      orcadFence: { environmentId: 7, sourceChangedAt: 3 }
    } as unknown as SshTarget)
    expect(loaded.owner).toBeUndefined()
    expect(loaded.orcadFence).toEqual({ environmentId: 'env-1' })
  })

  it("keeps a newer build's unknown fields on the fence and the server notes", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates fields a newer build adds.
    const loaded = normalizeSshTarget({
      ...base,
      orcadFence: { environmentId: 'env-1', sourceChangedAt: 4, addedLater: true },
      managedServerUnavailable: { reason: 'r', appVersion: '1', addedLater: 1 },
      managedServerMoveOffered: { appVersion: '1', addedLater: 'x' }
    } as unknown as SshTarget)
    expect(loaded.orcadFence).toEqual({ environmentId: 'env-1', addedLater: true })
    expect(loaded.managedServerUnavailable).toEqual({ reason: 'r', appVersion: '1', addedLater: 1 })
    expect(loaded.managedServerMoveOffered).toEqual({ appVersion: '1', addedLater: 'x' })
  })
})
