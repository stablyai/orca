import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as Registry from '../../../../managed-agent-cli/managed-agent-cli-registry'
import type { RpcContext } from '../../core'
import { MANAGED_RUNTIME_INSTALL_METHODS } from './managed-runtime-install'

const host = vi.hoisted(() => ({ dataDirectory: '', bin: '', enabled: true }))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => host.dataDirectory
}))
// A host whose own agy answers 1.5.4, below the floor.
vi.mock('../../../agent-session/launch/structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: async () => ({ PATH: host.bin, HOME: host.bin })
}))
vi.mock('../../../../managed-agent-cli/managed-agent-cli-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>()
  return {
    ...actual,
    managedAgentCli: () => ({
      runtime: { label: 'Agent', root: (data: string) => `${data}/rt`, pin: () => null },
      available: () => true,
      executable: (folder: string) => join(folder, 'agent')
    })
  }
})

const [subscribeMethod] = MANAGED_RUNTIME_INSTALL_METHODS
const watch = async () => {
  const frames: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the settings store and the stream registry.
  const ctx = {
    runtime: {
      requireStore: () => ({
        getSettings: () => ({ antigravityManagedAgyEnabled: host.enabled })
      }),
      registerOwnedSubscriptionCleanup: (_id: string, cleanup: () => void) => ({
        releaseIfCurrent: cleanup
      })
    },
    signal: new AbortController().signal
  } as unknown as RpcContext
  await subscribeMethod.handler({ agent: 'antigravity' }, ctx, (frame) => frames.push(frame))
  return frames
}

it.skipIf(process.platform === 'win32')(
  "offers Orca's agy for an own agy below the floor, without holding the first status read",
  async () => {
    host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-too-old-agy-'))
    host.bin = join(host.dataDirectory, 'bin')
    await mkdir(host.bin)
    await writeFile(join(host.bin, 'agy'), '#!/bin/sh\necho 1.5.4\n', { mode: 0o755 })

    const frames = await watch()
    // The first read answers before the version does, as the user's own agy.
    expect(frames[0]).toMatchObject({ source: 'external' })
    // Once the version lands, nothing installed reads as "install Orca's copy".
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ source: null }))
  }
)
