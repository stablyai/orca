import { beforeEach, expect, it, vi } from 'vitest'

// An unreadable registry must not matter to a page no SSH route applies to.
const mocks = vi.hoisted(() => ({ listEnvironments: vi.fn((): unknown[] => []) }))

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: mocks.listEnvironments
}))
vi.mock('../../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/registry'
}))

import { prepareWorkspaceBrowserRoutePartition } from './workspace-browser-route-partition'

const ROUTING_ON = { browserSshWorkspaceRoutingEnabled: true }

beforeEach(() => mocks.listEnvironments.mockClear())

it.each([
  { executionHostId: 'local', settings: ROUTING_ON },
  { executionHostId: 'runtime:env-1', settings: { browserSshWorkspaceRoutingEnabled: false } }
])(
  'opens a $executionHostId page without reading the environment registry when no route applies',
  async ({ executionHostId, settings }) => {
    await expect(
      prepareWorkspaceBrowserRoutePartition({
        executionHostId,
        browserProfileId: 'default',
        settings
      })
    ).resolves.toBeNull()
    expect(mocks.listEnvironments).not.toHaveBeenCalled()
  }
)

it("reads the registry to find a paired runtime's SSH target", async () => {
  await expect(
    prepareWorkspaceBrowserRoutePartition({
      executionHostId: 'runtime:env-1',
      browserProfileId: 'default',
      settings: ROUTING_ON
    })
  ).resolves.toBeNull()
  expect(mocks.listEnvironments).toHaveBeenCalledWith('/registry')
})
