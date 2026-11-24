import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const directory = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({ app: { getPath: () => directory.path } }))

vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    requireRouteBrowserProfile: (profileId: string) => {
      if (profileId !== 'default' && profileId !== 'work') {
        throw new Error('browser_route_partition_profile_unavailable')
      }
    }
  }
}))

beforeEach(async () => {
  directory.path = mkdtempSync(join(tmpdir(), 'orca-ssh-jar-'))
  const { configureBrowserRoutePartitionBindingsForOrcaProfile } =
    await import('../partitions/browser-route-partition-binding-runtime')
  configureBrowserRoutePartitionBindingsForOrcaProfile({
    orcaProfileId: 'local',
    profileDirectory: directory.path
  })
})

afterEach(() => {
  rmSync(directory.path, { recursive: true, force: true })
})

it("names only the selected SSH host's jar for the selected profile, and a lookup never binds one", async () => {
  const { bindLocalSshBrowserPartition, boundLocalSshBrowserPartition } =
    await import('./local-ssh-browser-partition-bindings')
  expect(boundLocalSshBrowserPartition('staging', 'work')).toBeNull()
  expect(boundLocalSshBrowserPartition('staging', 'work')).toBeNull()

  const stagingWork = bindLocalSshBrowserPartition('staging', 'work')
  const prodWork = bindLocalSshBrowserPartition('prod', 'work')
  expect(boundLocalSshBrowserPartition('staging', 'work')).toBe(stagingWork)
  expect(boundLocalSshBrowserPartition('prod', 'work')).toBe(prodWork)
  expect(prodWork).not.toBe(stagingWork)
  expect(boundLocalSshBrowserPartition('staging', 'default')).toBeNull()
})
