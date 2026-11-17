import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => undefined)
}))

import {
  isPairedCloudEnvironmentDormant,
  notePairedCloudSandboxStatus,
  resetPairedCloudDormant
} from './cloud-paired-dormant'
import { noteCloudPairingBindings } from './cloud-paired-environment-ids'
import { wakePairedSandbox } from './cloud-paired-wake'

const asleep = { state: 'sleeping' as const, archive: null }
const ready = { state: 'ready' as const, archive: null }
const archived = {
  state: 'archived' as const,
  archive: { archivedAt: 1, expiresAt: null }
}

afterEach(() => {
  noteCloudPairingBindings({})
  resetPairedCloudDormant()
})

describe('paired cloud dormant', () => {
  it('an asleep or archived sandbox stops background dials to only its bound server', () => {
    noteCloudPairingBindings({
      sbx_gh: { environmentId: 'env-gh' },
      sbx_other: { environmentId: 'env-other' }
    })
    notePairedCloudSandboxStatus('sbx_gh', asleep)
    expect(isPairedCloudEnvironmentDormant('env-gh')).toBe(true)
    expect(isPairedCloudEnvironmentDormant('env-other')).toBe(false)

    notePairedCloudSandboxStatus('sbx_other', archived)
    expect(isPairedCloudEnvironmentDormant('env-other')).toBe(true)
  })

  it('a later read that says it is running resumes dials (woken from another computer)', () => {
    noteCloudPairingBindings({ sbx_gh: { environmentId: 'env-gh' } })
    notePairedCloudSandboxStatus('sbx_gh', asleep)
    notePairedCloudSandboxStatus('sbx_gh', ready)
    expect(isPairedCloudEnvironmentDormant('env-gh')).toBe(false)
  })

  it('a wake resumes dials before it reconnects; a refused wake keeps it dormant', async () => {
    noteCloudPairingBindings({ sbx_gh: { environmentId: 'env-gh' } })
    notePairedCloudSandboxStatus('sbx_gh', asleep)
    const refused = { ok: false as const, error: 'Sandbox hours used up' }
    await wakePairedSandbox({ wake: async () => refused }, 'sbx_gh', async () => undefined)
    expect(isPairedCloudEnvironmentDormant('env-gh')).toBe(true)

    let dormantAtReconnect: boolean | null = null
    await wakePairedSandbox(
      { wake: async () => ({ ok: true as const, value: undefined }) },
      'sbx_gh',
      async (environmentId) => {
        dormantAtReconnect = isPairedCloudEnvironmentDormant(environmentId)
      }
    )
    expect(dormantAtReconnect).toBe(false)
  })
})
