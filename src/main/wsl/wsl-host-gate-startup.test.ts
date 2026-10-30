import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWslHostDeployment } from '../../shared/wsl-host-deployment-store'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoveJournalDirectory } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  resetWslHostsGateForTests,
  wslHostsAppliedPolicyState,
  wslHostsBringBackMovedProjects,
  wslHostsGateOpen,
  wslHostsGateState,
  wslHostsPolicyBlocked
} from './wsl-host-gate'
import { configureWslHostsGateFromDisk } from './wsl-host-gate-startup'
import { wslHostsPolicyCacheFileName } from './wsl-hosts-policy-live-update'

const STABLE = '1.4.2'

describe('WSL hosts gate startup promotion', () => {
  let userDataPath: string
  beforeEach(() => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-gate-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    resetWslHostsGateForTests()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('stays closed and creates nothing for a profile that never had WSL work', () => {
    configureWslHostsGateFromDisk(userDataPath, STABLE)

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
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  it('serves a committed move', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  // Recovery must still reset an in-flight move whose host record is already gone.
  it('serves a move that never committed', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  describe('with the internal gate open and a cached remote policy', () => {
    const cachePolicy = (wslHosts: 'allow' | 'block', movedProjects?: 'keep' | 'bring-back') =>
      writeFileSync(
        join(userDataPath, wslHostsPolicyCacheFileName('stable')),
        JSON.stringify({ version: 1, revision: 1, wslHosts, movedProjects })
      )
    const seedSavedHost = () =>
      writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
        kind: 'wsl',
        distro: 'Ubuntu',
        localPort: 41000,
        remotePort: 6768,
        environmentId: 'wsl:ubuntu',
        createdAt: 1
      })
    beforeEach(() => {
      vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    })

    it('stays open with no cached policy', () => {
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('open')
      expect(wslHostsPolicyBlocked()).toBe(false)
      expect(wslHostsAppliedPolicyState()).toBe('missing')
    })

    // A move or host running in this session is never pulled out from under the user.
    it('applies a block cached mid-run only at the next launch', () => {
      configureWslHostsGateFromDisk(userDataPath, STABLE)
      cachePolicy('block')

      expect(wslHostsGateOpen()).toBe(true)
      expect(wslHostsAppliedPolicyState()).toBe('missing')

      configureWslHostsGateFromDisk(userDataPath, STABLE)
      expect(wslHostsGateOpen()).toBe(false)
      expect(wslHostsAppliedPolicyState()).toBe('block')
    })

    it('stays open on an allow', () => {
      cachePolicy('allow')
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('open')
    })

    it('closes on a block when nothing was saved', () => {
      cachePolicy('block')
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('closed')
      expect(wslHostsPolicyBlocked()).toBe(true)
    })

    it('keeps serving saved hosts and moves on a block, with nothing new allowed', () => {
      cachePolicy('block')
      seedSavedHost()
      seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('serve-only')
      expect(wslHostsGateOpen()).toBe(false)
    })

    it('reads a block that asks for moved projects back', () => {
      cachePolicy('block', 'bring-back')
      seedSavedHost()
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('serve-only')
      expect(wslHostsBringBackMovedProjects()).toBe(true)
    })

    it('ignores bring-back on an allow', () => {
      cachePolicy('allow', 'bring-back')
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('open')
      expect(wslHostsBringBackMovedProjects()).toBe(false)
    })

    it('ignores a block cached for another channel', () => {
      cachePolicy('block')
      configureWslHostsGateFromDisk(userDataPath, '1.4.3-rc.1')

      expect(wslHostsGateState()).toBe('open')
    })

    it('treats an unreadable cached policy as no policy', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      writeFileSync(join(userDataPath, wslHostsPolicyCacheFileName('stable')), '{"wslHosts":')
      configureWslHostsGateFromDisk(userDataPath, STABLE)

      expect(wslHostsGateState()).toBe('open')
    })
  })
})
