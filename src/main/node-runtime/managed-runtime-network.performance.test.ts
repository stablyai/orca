import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedRuntimePin } from './managed-runtime-release'
import { ManagedRuntimeInstallation } from './managed-runtime-installation'

const roots: string[] = []
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
)

it.each([10, 100])(
  'reads %s installation cards without release requests, then installs on request',
  async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-runtime-network-'))
    roots.push(root)
    let pin: ManagedRuntimePin | null = null
    const refreshPin = vi.fn(async () => {
      pin = {
        version: '1.0',
        url: 'https://example.test/agent',
        archiveBytes: 5,
        archiveSha256: 'd4f0bc5a29de06b510f9aa428f1eedba926012b591fef7a518e776a7c9bd1824',
        format: 'file',
        members: [
          {
            path: 'agent',
            bytes: 5,
            sha256: 'd4f0bc5a29de06b510f9aa428f1eedba926012b591fef7a518e776a7c9bd1824'
          }
        ]
      }
    })
    const installation = new ManagedRuntimeInstallation(
      'agent',
      {
        label: 'Agent',
        root: () => root,
        pin: () => pin,
        refreshPin
      },
      {
        dataDirectory: root,
        program: 'cli',
        available: () => true,
        findExternal: async () => false,
        updatesEnabled: () => false,
        fence: (work) => work(),
        fetcher: async () => new Response('agent')
      }
    )
    for (let index = 0; index < count; index += 1) {
      expect(await installation.status()).toMatchObject({ available: true, installedVersion: null })
      await installation.updateIfBehind()
    }
    expect(refreshPin).toHaveBeenCalledTimes(0)
    installation.install()
    await vi.waitFor(async () =>
      expect((await installation.status(false)).operation?.phase).toBe('succeeded')
    )
    expect(refreshPin).toHaveBeenCalledTimes(1)
    expect(await installation.status()).toMatchObject({
      installedVersion: '1.0',
      source: 'managed'
    })
    await installation.updateIfBehind()
    expect(refreshPin).toHaveBeenCalledTimes(1)
  }
)
