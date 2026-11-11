import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handlers, resetFilesystemIpcMocks } from './filesystem-test-harness'
import type { StateWriteListener } from '../../persistence/loading-store/write-scheduling'

const read = vi.hoisted(() =>
  vi.fn(async () => ({ entries: [], conflictOperation: 'unknown', repositoryStatuses: [] }))
)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('../../git/source-control/repository-status', () => ({ getRepositoryStatuses: read }))
vi.mock('./access/local-file-access-resolution', () => ({
  resolveDesktopAuthorizedPath: async (path: string) => path
}))
vi.mock('../../wsl/filesystem/wsl-unc-access-gate', () => ({
  assertWslUncPathRunning: async () => {}
}))
vi.mock('../../wsl/discovery/wsl-availability', () => ({
  hasCachedWslAvailability: () => true,
  getCachedWslAvailability: () => true
}))
vi.mock('../../wsl/discovery/distro-catalog', () => ({
  hasCachedWslDistros: () => true,
  getCachedWslDistros: () => ['Ubuntu', 'Debian']
}))

import { registerFilesystemGitStatusHandlers } from './filesystem-git-status-handlers'
import { createFilesystemHandlerContext } from './filesystem-handler-context'
import { createSenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'

beforeEach(resetFilesystemIpcMocks)

const originalPlatform = process.platform
afterEach(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
)

it.each([750, 7500])(
  'shares a live scoped workspace lookup across requests at %i metadata rows and invalidates in-place changes',
  async (count) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const metadata: Record<string, object> = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`a::/work/${index}`, {}])
    )
    metadata['a::/work/target'] = {}
    metadata['b::/work/target'] = {}
    const scans = vi.fn(() => metadata)
    let written: StateWriteListener = () => {}
    const repos: { id: string; path: string; connectionId: string | null }[] = [
      { id: 'a', path: '/repos/a', connectionId: null },
      { id: 'b', path: '/repos/b', connectionId: null }
    ]
    const preference = { kind: 'wsl', distro: 'Ubuntu' }
    const store = {
      getRepos: () => repos,
      getAllWorktreeMeta: scans,
      getSettings: () => ({}),
      getProjects: () => [
        { id: 'project', sourceRepoIds: ['a', 'b'], localWindowsRuntimePreference: preference }
      ],
      onStateWritten: (listener: StateWriteListener) => {
        written = listener
        return () => {}
      }
    }
    const register = (target: typeof store): void => {
      const context = createFilesystemHandlerContext(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scoped IPC uses only these supplied catalog, runtime and notification methods.
        target as never,
        undefined,
        createSenderScopedRequestCancellations(),
        createSenderScopedRequestCancellations()
      )
      registerFilesystemGitStatusHandlers(context)
    }
    const call = async (intent: 'probe' | 'status' | 'ignored') =>
      handlers.get('git:status')!(null, {
        worktreePath: '/work/target',
        repositoryPaths: ['child'],
        repositoryIntent: intent,
        repositoryQueryPaths: ['file']
      })
    register(store)
    read.mockClear()
    for (const intent of ['probe', 'status', 'ignored', 'status', 'ignored'] as const) {
      await call(intent)
    }
    expect(scans).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith(
      '/work/target',
      expect.anything(),
      expect.objectContaining({ wslDistro: 'Ubuntu', admissionTier: 'background' })
    )
    preference.distro = 'Debian'
    await call('status')
    expect(scans).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith(
      '/work/target',
      expect.anything(),
      expect.objectContaining({ wslDistro: 'Debian' })
    )
    delete metadata['a::/work/target']
    delete metadata['b::/work/target']
    written(['worktreeMeta'])
    await call('probe')
    expect(scans).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith('/work/target', expect.anything(), {
      admissionTier: 'background'
    })
    metadata['b::/work/target'] = {}
    written(undefined)
    await call('status')
    expect(scans).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith(
      '/work/target',
      expect.anything(),
      expect.objectContaining({ wslDistro: 'Debian' })
    )
    // Hot metadata writes cost one lazy rebuild each; successive scoped calls still share it.
    for (let index = 0; index < 3; index++) {
      written(['worktreeMetaByIdentity'])
      await call('probe')
      await call('ignored')
    }
    expect(scans).toHaveBeenCalledTimes(6)
    repos[1].connectionId = 'unserved'
    await call('status')
    expect(scans).toHaveBeenCalledTimes(6)
    expect(read).toHaveBeenLastCalledWith('/work/target', expect.anything(), {
      admissionTier: 'background'
    })
    const otherScans = vi.fn(() => ({}))
    register({ ...store, getAllWorktreeMeta: otherScans })
    await call('status')
    expect(otherScans).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith('/work/target', expect.anything(), {
      admissionTier: 'background'
    })
  }
)
