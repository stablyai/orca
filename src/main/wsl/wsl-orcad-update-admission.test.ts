import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { recordOrcadUpdateFailedThisLaunch } from '../managed-server/lifecycle/orcad-managed-update-failure-memory'
import type { ServeReadiness } from '../server/serve-readiness'

import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { admitWslOrcadUpdate } from './wsl-orcad-update-admission'

const { adoptRunningOrcadVersion, readOrcadActivationRecord } = vi.hoisted(() => ({
  adoptRunningOrcadVersion: vi.fn(),
  readOrcadActivationRecord: vi.fn()
}))

vi.mock('../ssh/orcad-running-version-adoption', () => ({ adoptRunningOrcadVersion }))
vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord
}))

// Mixed versions between this desktop and a WSL distro's orcad: they update independently.
const OLDER = '1.5.0+aaaaaaaaaaaa'
const NEWER = '1.6.0+bbbbbbbbbbbb'
const slot: OrcadSlotOptions = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  conn: {} as OrcadSlotOptions['conn'],
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 6768
}
const readiness: ServeReadiness = {
  runtimeId: 'wsl-runtime',
  boundEndpoint: '127.0.0.1:6768',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: '' }
}
let hostSeq = 0

function running(version: string, appVersion: string): OrcadActivationRecord {
  return {
    schemaVersion: 1,
    active: version,
    previous: null,
    activatedAt: '2026-10-01T00:00:00.000Z',
    snapshot: null,
    activeAppVersion: appVersion
  }
}

function admit(
  record: OrcadActivationRecord,
  desktop: { candidateVersion: string; appVersion: string },
  options: { intent?: 'connect' | 'update' | 'force'; host?: { kind: 'wsl'; id: string } } = {}
) {
  return admitWslOrcadUpdate({
    slot,
    record,
    ...desktop,
    host: options.host ?? { kind: 'wsl', id: `Ubuntu-${(hostSeq += 1)}` },
    intent: options.intent ?? 'connect'
  })
}

beforeEach(() => {
  adoptRunningOrcadVersion.mockReset()
  readOrcadActivationRecord.mockReset()
})

describe('WSL orcad admission across desktop and host versions', () => {
  describe('an older desktop meets the orcad a newer desktop deployed', () => {
    const olderDesktop = { candidateVersion: OLDER, appVersion: '1.5.0' }

    it('keeps the newer orcad serving its terminals, with no Update hint', async () => {
      adoptRunningOrcadVersion.mockResolvedValue({ version: NEWER, readiness, reprobe: vi.fn() })
      for (const intent of ['connect', 'update'] as const) {
        expect(await admit(running(NEWER, '1.6.0'), olderDesktop, { intent })).toEqual({
          action: 'serve',
          version: NEWER,
          readiness,
          deferredUpdate: null
        })
      }
      expect(adoptRunningOrcadVersion).toHaveBeenCalledWith(slot, running(NEWER, '1.6.0'), OLDER)
    })
  })

  describe('a newer desktop meets the orcad an older desktop deployed', () => {
    const newerDesktop = { candidateVersion: NEWER, appVersion: '1.6.0' }

    it('keeps the older orcad serving after a failed update, and offers Force', async () => {
      const host = { kind: 'wsl' as const, id: 'Ubuntu-failed' }
      recordOrcadUpdateFailedThisLaunch(host, { code: 'orcad_activation_failed', reason: 'boom' })
      adoptRunningOrcadVersion.mockResolvedValue({ version: OLDER, readiness, reprobe: vi.fn() })
      expect(await admit(running(OLDER, '1.5.0'), newerDesktop, { host })).toEqual({
        action: 'serve',
        version: OLDER,
        readiness,
        deferredUpdate: {
          candidateVersion: NEWER,
          code: 'orcad_activation_failed',
          reason: 'boom',
          forceable: true
        }
      })
    })
  })
})
