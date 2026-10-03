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
})
