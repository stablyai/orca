/**
 * A host without the WSL-source capability refuses the move. Only a host with an update waiting
 * is called old; one already up to date was started outside WSL hosts, such as over SSH (#43632),
 * and only a host whose row offers Restart as WSL host gets copy naming it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-internal-gate'
import { testState } from '../../persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  type WslMoveRig
} from '../../__fixtures__/wsl-mover/wsl-move-kill-rig'
import { resetWslMoveDesktopRewriteStoresForTests } from '../desktop-state/wsl-move-desktop-rewrite-stores'
import { previewWslMove } from './wsl-move-driver-preview'
import type { WslMoveHostServerState } from './wsl-move-driver-ports'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

let rig: WslMoveRig

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  rig = createWslMoveKillRig()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  await removeWslMoveRigDirs()
})

async function previewWithoutWslCapability(serverState: WslMoveHostServerState): Promise<unknown> {
  const connect = rig.world.deps.connectHost
  rig.world.deps.connectHost = async (distro) => {
    const host = await connect(distro)
    return (
      host && {
        ...host,
        capabilities: host.capabilities.filter(
          (capability) => capability !== ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
        ),
        serverState
      }
    )
  }
  return previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
}

describe('WSL move host readiness', () => {
  it('blames the launch, not the version, and names the restart only when the row offers it', async () => {
    expect(await previewWithoutWslCapability('restart-offered')).toEqual({
      outcome: 'refused',
      code: 'wsl_move_host_update_required',
      detail: 'host-not-started-as-wsl-host'
    })
    expect(await previewWithoutWslCapability('current')).toEqual({
      outcome: 'refused',
      code: 'wsl_move_host_update_required',
      detail: 'host-launch-unproven'
    })
    expect(await previewWithoutWslCapability('update-pending')).toEqual({
      outcome: 'refused',
      code: 'wsl_move_host_update_required'
    })
  })
})
