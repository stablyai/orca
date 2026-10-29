import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWslHostDeployment } from '../../shared/wsl-host-deployment-store'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoveJournalDirectory } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { resetWslHostsGateForTests, wslHostsGateState } from './wsl-host-gate'
import { configureWslHostsGateFromDisk } from './wsl-host-gate-startup'

describe('WSL hosts gate startup promotion', () => {
  let userDataPath: string
  beforeEach(() => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-gate-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetWslHostsGateForTests()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('stays closed and creates nothing for a profile that never had WSL work', () => {
    configureWslHostsGateFromDisk(userDataPath)

    expect(wslHostsGateState()).toBe('closed')
    expect(existsSync(wslMoveJournalDirectory(userDataPath))).toBe(false)
  })

  it('serves a saved WSL host', () => {
    writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      kind: 'wsl',
      distro: 'Ubuntu',
      localPort: 41000,
      remotePort: 6768,
      environmentId: 'wsl:ubuntu',
      createdAt: 1
    })
    configureWslHostsGateFromDisk(userDataPath)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  it('serves a committed move', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    configureWslHostsGateFromDisk(userDataPath)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  // Recovery must still reset an in-flight move whose host record is already gone.
  it('serves a move that never committed', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    configureWslHostsGateFromDisk(userDataPath)

    expect(wslHostsGateState()).toBe('serve-only')
  })
})
