import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE } from '../../shared/wsl-host-types'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { admitWslOrcadUpdate } from './wsl-orcad-update-admission'

const { adoptRunningOrcadVersion } = vi.hoisted(() => ({ adoptRunningOrcadVersion: vi.fn() }))

vi.mock('../ssh/orcad-running-version-adoption', () => ({ adoptRunningOrcadVersion }))
vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: vi.fn()
}))

const RUNNING = '1.5.0+aaaaaaaaaaaa'
const BUNDLED = '1.6.0+bbbbbbbbbbbb'
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
const record: OrcadActivationRecord = {
  schemaVersion: 1,
  active: RUNNING,
  previous: null,
  activatedAt: '2026-10-01T00:00:00.000Z',
  snapshot: null,
  activeAppVersion: '1.5.0'
}
let hostSeq = 0

function admit(intent: 'connect' | 'update' | 'force', moveRunning: boolean) {
  return admitWslOrcadUpdate({
    slot,
    record,
    candidateVersion: BUNDLED,
    appVersion: '1.6.0',
    host: { kind: 'wsl', id: `Ubuntu-${(hostSeq += 1)}` },
    intent,
    moveRunning
  })
}

beforeEach(() => {
  adoptRunningOrcadVersion.mockReset()
  adoptRunningOrcadVersion.mockResolvedValue({ version: RUNNING, readiness, reprobe: vi.fn() })
})

describe('a WSL orcad update while a project moves onto the host', () => {
  it.each(['connect', 'update', 'force'] as const)(
    'keeps the running server for the move on %s, and says the update waits for it',
    async (intent) => {
      expect(await admit(intent, true)).toEqual({
        action: 'serve',
        version: RUNNING,
        readiness,
        deferredUpdate: {
          candidateVersion: BUNDLED,
          code: ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE,
          reason: expect.stringContaining('once the move finishes'),
          forceable: false
        }
      })
    }
  )

  it('updates as before once no move runs', async () => {
    expect(await admit('connect', false)).toEqual({ action: 'deploy', record })
    expect(adoptRunningOrcadVersion).not.toHaveBeenCalled()
  })
})
