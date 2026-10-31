import { join } from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import type * as OmpRpcLaunch from './rpc-launch'
import { beforeEach, expect, it, vi } from 'vitest'
import { FakeConnection } from '../pi/rpc-session-adapter.test-fixture'
import { openOmpRpcConnection } from './rpc-connection'
import { resolveOmpRpcInvocation } from './rpc-launch'
import { createOmpRpcModelCatalogProbe } from './rpc-model-catalog-probe'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn()
}))
vi.mock('./rpc-connection', () => ({ openOmpRpcConnection: vi.fn() }))
vi.mock('./rpc-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof OmpRpcLaunch>()),
  resolveOmpRpcInvocation: vi.fn()
}))

beforeEach(() => vi.resetAllMocks())

it.each([false, true])(
  'keeps the discovery outcome when scratch cleanup fails (listing fails: %s)',
  async (listingFails) => {
    const scratch = join('isolated-state', 'omp-rpc', 'catalog-test')
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(mkdtemp).mockResolvedValue(scratch)
    const cleanupFailure = new Error('EBUSY')
    vi.mocked(rm).mockRejectedValue(cleanupFailure)
    vi.mocked(resolveOmpRpcInvocation).mockResolvedValue({
      command: 'omp',
      prefixArgs: [],
      env: {}
    })
    const connection = new FakeConnection({})
    const listingFailure = new Error('Model listing unavailable')
    connection.requestOverride = (command) =>
      command === 'get_available_models' && listingFails
        ? Promise.reject(listingFailure)
        : undefined
    vi.mocked(openOmpRpcConnection).mockReturnValue(connection)
    const logger = { warn: vi.fn(), error: vi.fn() }
    const probe = createOmpRpcModelCatalogProbe({
      deps: {
        stateDirectory: 'isolated-state',
        hostId: 'local',
        claimKeyId: 'test',
        resolveWorkspacePath: async () => 'workspace',
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'system' }),
        logger
      },
      environment: {
        resolveBaseEnvironment: async () => ({}),
        resolveAgentEnvironment: async () => ({}),
        refreshAfterMissingProgram: async () => {},
        bindCatalogSources: () => () => {}
      }
    })
    const result = probe(
      { variable: 'PI_CODING_AGENT_DIR', path: 'account' },
      { workspacePath: 'workspace' }
    )
    await (listingFails
      ? expect(result).rejects.toBe(listingFailure)
      : expect(result).resolves.toMatchObject({
          models: [expect.objectContaining({ id: 'anthropic/model-1' })]
        }))
    expect(connection.closed).toBe(true)
    expect(rm).toHaveBeenCalledWith(
      scratch,
      expect.objectContaining({ recursive: true, force: true, maxRetries: 3 })
    )
    expect(logger.warn).toHaveBeenCalledWith(
      'OMP model catalog scratch cleanup failed',
      expect.objectContaining({ error: cleanupFailure })
    )
  }
)
