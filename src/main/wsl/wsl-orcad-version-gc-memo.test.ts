import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedOrcadPruneArgs } from '../managed-server/lifecycle/orcad-managed-version-gc'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  pruneWslOrcadVersionsUntilClean,
  resetWslOrcadVersionGcMemoForTests
} from './wsl-orcad-version-gc-memo'

function args(activeVersion: string, daemon: string | null): ManagedOrcadPruneArgs {
  const terminalDaemon =
    daemon === null
      ? { state: 'absent', buildVersion: null }
      : { state: 'live', buildVersion: daemon }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the memo reads only remoteHome; prune is faked.
    slot: { remoteHome: '/home/u' } as ManagedOrcadPruneArgs['slot'],
    serverTarget: 'linux-x64-glibc',
    activeVersion,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health.terminalDaemon is read.
    readiness: { health: { terminalDaemon } } as unknown as ServeReadiness
  }
}

beforeEach(() => {
  resetWslOrcadVersionGcMemoForTests()
})

describe('pruneWslOrcadVersionsUntilClean', () => {
  it('skips GC on later connects once one left nothing behind under the same pins', async () => {
    const prune = vi.fn(async () => true)

    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', '2.0.0'), prune)
    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', '2.0.0'), prune)

    expect(prune).toHaveBeenCalledTimes(1)
  })

  it('keeps running GC while a run leaves something behind', async () => {
    const prune = vi.fn(async () => false)

    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', '2.0.0'), prune)
    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', '2.0.0'), prune)

    expect(prune).toHaveBeenCalledTimes(2)
  })

  it('runs again when the active version, the daemon or the distro changes', async () => {
    const prune = vi.fn(async () => true)

    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', '1.0.0'), prune)
    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('2.0.0', null), prune)
    await pruneWslOrcadVersionsUntilClean('wsl:ubuntu', args('3.0.0', null), prune)
    await pruneWslOrcadVersionsUntilClean('wsl:debian', args('3.0.0', null), prune)

    expect(prune).toHaveBeenCalledTimes(4)
  })
})
