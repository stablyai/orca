import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { handleMock, recordWorkspaceTrustDecisionMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  recordWorkspaceTrustDecisionMock: vi.fn(() => Promise.resolve({}))
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn(() => Promise.resolve({}))
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(() => Promise.resolve())
}))
vi.mock('../registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('./repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('../../workspace-trust/workspace-trust-service', () => ({
  recordWorkspaceTrustDecision: recordWorkspaceTrustDecisionMock
}))

import { registerRepoCreationHandlers } from './repo-creation-handlers'

type CreateHandlerArgs = { parentPath: string; name: string; kind: 'git' | 'folder' }
type CreateHandlerResult = { repo?: Record<string, unknown>; error?: string }
type CreateRemoteHandlerArgs = {
  connectionId: string
  parentPath: string
  name: string
  kind: 'git' | 'folder'
}

function findHandler<Args, Result>(channel: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `ipcMain.handle` is a heterogeneous registry keyed by channel string, so no type links a channel to its handler signature. The recovered signature is the one `registerRepoCreationHandlers` registers for this channel, and the lookup returns `undefined` for an unregistered channel, which fails the awaiting test immediately.
  return handleMock.mock.calls.find((call) => call[0] === channel)?.[1] as (
    _event: unknown,
    args: Args
  ) => Promise<Result>
}

describe('registerRepoCreationHandlers — workspace trust boundary', () => {
  const tempDirs: string[] = []
  const store = {
    getRepos: vi.fn(() => []),
    addRepo: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only forward this window to `notifyReposChanged`, which is mocked above, so no member of `BrowserWindow` is ever read from this stub.
  const mainWindow = {} as never

  beforeEach(() => {
    handleMock.mockClear()
    recordWorkspaceTrustDecisionMock.mockClear()
    store.getRepos.mockClear()
    store.addRepo.mockClear()
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a trusted, intake-origin entry in-process before repos:create returns', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `Store` is the whole persistence surface; this fake implements the only two members `repos:create` reaches (`getRepos`, `addRepo`), and every other collaborator is mocked above.
    registerRepoCreationHandlers(mainWindow, store as never)
    const handler = findHandler<CreateHandlerArgs, CreateHandlerResult>('repos:create')
    const parentPath = mkdtempSync(join(tmpdir(), 'workspace-trust-repos-create-'))
    tempDirs.push(parentPath)

    const result = await handler({}, { parentPath, name: 'proj', kind: 'folder' })

    expect(result.repo).toBeDefined()
    expect(recordWorkspaceTrustDecisionMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        path: join(parentPath, 'proj'),
        scope: 'workspace',
        decision: 'trust',
        origin: 'intake'
      })
    )
    // Guards the Out-of-Scope boundary: repos:create never touches projectHostSetupMethod for folder kind.
    expect(result.repo?.projectHostSetupMethod).toBeUndefined()
  })

  it('writes no trust entry for repos:createRemote (remote is not-applicable to local trust)', async () => {
    vi.doMock('./remote-repo-creation', () => ({
      createRemoteRepo: vi.fn(() =>
        Promise.resolve({
          repo: {
            id: 'r1',
            path: '/remote/proj',
            displayName: 'proj',
            badgeColor: '#fff',
            addedAt: 1
          }
        })
      )
    }))
    vi.resetModules()
    handleMock.mockClear()
    const { registerRepoCreationHandlers: register } = await import('./repo-creation-handlers')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fake `Store` as above, re-registered after `vi.resetModules()`; `repos:createRemote` delegates to the mocked `createRemoteRepo` and reaches no unimplemented member.
    register(mainWindow, store as never)
    const handler = findHandler<CreateRemoteHandlerArgs, CreateHandlerResult>('repos:createRemote')

    await handler(
      {},
      {
        connectionId: 'ssh-1',
        parentPath: '/remote',
        name: 'proj',
        kind: 'folder'
      }
    )

    expect(recordWorkspaceTrustDecisionMock).not.toHaveBeenCalled()
  })
})
