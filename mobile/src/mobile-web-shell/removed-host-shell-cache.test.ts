import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('./generation-store-file-system', async () => {
  const { createFakeGenerationFileSystem } = await import('./generation-file-system-fake')
  const fileSystem = createFakeGenerationFileSystem()
  return { createExpoGenerationFileSystem: () => fileSystem }
})

import { createGenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'
import { forgetHostUpdateFailures } from './removed-host-shell-cache'

function store() {
  return createGenerationStore({ fileSystem: createExpoGenerationFileSystem() })
}

async function seed(hostId: string): Promise<void> {
  await store().recordUpdateFailure({
    hostId,
    at: 1,
    reason: 'connection-lost',
    hostCode: null,
    offeredBuildId: null,
    cachedBuildId: null,
    outcome: 'opened-cached',
    wall: null
  })
}

describe('forgetHostUpdateFailures', () => {
  beforeEach(async () => {
    await store().forgetHostUpdateFailures('host-1')
    await store().forgetHostUpdateFailures('host-2')
  })

  it("drops the removed host's records and keeps the rest", async () => {
    await seed('host-1')
    await seed('host-2')
    await forgetHostUpdateFailures('host-1')
    expect((await store().readUpdateFailures()).map((entry) => entry.hostId)).toEqual(['host-2'])
  })

  it('writes nothing when nothing was recorded', async () => {
    await forgetHostUpdateFailures('host-1')
    const fileSystem = createExpoGenerationFileSystem()
    expect(await fileSystem.readText(`${fileSystem.rootUri}/update-failures.json`)).toBeNull()
  })
})
