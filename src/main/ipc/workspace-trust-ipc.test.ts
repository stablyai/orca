import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  resolveWorkspaceTrustIntakeMock,
  recordWorkspaceTrustDecisionMock,
  revokeWorkspaceTrustEntryMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  resolveWorkspaceTrustIntakeMock: vi.fn(),
  recordWorkspaceTrustDecisionMock: vi.fn(() => Promise.resolve({ id: 'entry-1' })),
  revokeWorkspaceTrustEntryMock: vi.fn(() => Promise.resolve(true))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  BrowserWindow: { fromWebContents: vi.fn(() => null) }
}))
vi.mock('../workspace-trust/workspace-trust-intake-resolution', () => ({
  resolveWorkspaceTrustIntake: resolveWorkspaceTrustIntakeMock
}))
vi.mock('../workspace-trust/workspace-trust-service', () => ({
  recordWorkspaceTrustDecision: recordWorkspaceTrustDecisionMock,
  revokeWorkspaceTrustEntry: revokeWorkspaceTrustEntryMock
}))

import { registerWorkspaceTrustHandlers } from './workspace-trust-ipc'

function findHandler<Args, Result>(channel: string) {
  return handleMock.mock.calls.find((call) => call[0] === channel)?.[1] as (
    _event: unknown,
    args: Args
  ) => Promise<Result>
}

describe('registerWorkspaceTrustHandlers', () => {
  const mainWindow = {} as never
  type FakeRepo = { id: string; path: string; connectionId: string | null }
  const store = {
    getRepos: vi.fn((): FakeRepo[] => [
      { id: 'repo-1', path: '/home/user/work/proj', connectionId: null }
    ]),
    getFolderWorkspace: vi.fn((id: string) =>
      id === 'fw-1' ? { id: 'fw-1', folderPath: '/home/user/notes' } : undefined
    )
  }

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    resolveWorkspaceTrustIntakeMock.mockReset()
    recordWorkspaceTrustDecisionMock.mockClear()
    revokeWorkspaceTrustEntryMock.mockClear()
    store.getRepos.mockClear()
    store.getFolderWorkspace.mockClear()
    registerWorkspaceTrustHandlers(mainWindow, store as never)
  })

  describe('workspaceTrust:resolveIntake — security boundary', () => {
    it('never reads or forwards a renderer-supplied provenance field', async () => {
      resolveWorkspaceTrustIntakeMock.mockResolvedValue({
        outcome: 'prompt',
        reason: 'no-decision'
      })
      const handler = findHandler('workspaceTrust:resolveIntake')

      await handler({} as never, {
        target: { kind: 'repo', repoId: 'repo-1' },
        provenance: 'created'
      })

      expect(resolveWorkspaceTrustIntakeMock).toHaveBeenCalledTimes(1)
      const forwardedProvenance = resolveWorkspaceTrustIntakeMock.mock.calls[0][2]
      expect(forwardedProvenance).not.toBe('created')
      expect(forwardedProvenance).toBe('added')
    })

    it('ignores extra fields entirely and still resolves from the target', async () => {
      resolveWorkspaceTrustIntakeMock.mockResolvedValue({
        outcome: 'inherit-trusted',
        inheritedFrom: '/home/user/work'
      })
      const handler = findHandler('workspaceTrust:resolveIntake')

      const result = await handler({} as never, {
        target: { kind: 'repo', repoId: 'repo-1' },
        provenance: 'created',
        path: '/some/other/path'
      })

      expect(resolveWorkspaceTrustIntakeMock).toHaveBeenCalledWith(
        '/home/user/work/proj',
        store,
        'added'
      )
      expect(result).toEqual({ outcome: 'inherit-trusted', inheritedFrom: '/home/user/work' })
    })
  })

  describe('workspaceTrust:resolveIntake — target resolution', () => {
    it('resolves a folder-workspace target via the store', async () => {
      resolveWorkspaceTrustIntakeMock.mockResolvedValue({
        outcome: 'prompt',
        reason: 'no-decision'
      })
      const handler = findHandler('workspaceTrust:resolveIntake')

      await handler({} as never, { target: { kind: 'folderWorkspace', folderWorkspaceId: 'fw-1' } })

      expect(resolveWorkspaceTrustIntakeMock).toHaveBeenCalledWith(
        '/home/user/notes',
        store,
        'folder-workspace'
      )
    })

    it('returns not-applicable for an unknown repo id', async () => {
      const handler = findHandler('workspaceTrust:resolveIntake')

      const result = await handler({} as never, { target: { kind: 'repo', repoId: 'missing' } })

      expect(result).toEqual({ outcome: 'not-applicable' })
      expect(resolveWorkspaceTrustIntakeMock).not.toHaveBeenCalled()
    })

    it('returns not-applicable for a remote-hosted repo (connectionId set)', async () => {
      store.getRepos.mockReturnValueOnce([
        { id: 'repo-2', path: '/remote/proj', connectionId: 'ssh-1' }
      ])
      const handler = findHandler('workspaceTrust:resolveIntake')

      const result = await handler({} as never, { target: { kind: 'repo', repoId: 'repo-2' } })

      expect(result).toEqual({ outcome: 'not-applicable' })
      expect(resolveWorkspaceTrustIntakeMock).not.toHaveBeenCalled()
    })

    it('returns not-applicable for a malformed target payload', async () => {
      const handler = findHandler('workspaceTrust:resolveIntake')

      const result = await handler({} as never, { target: { kind: 'nonsense' } })

      expect(result).toEqual({ outcome: 'not-applicable' })
    })
  })

  describe('workspaceTrust:decide', () => {
    it('resolves the path from the store and records the decision for scope:workspace', async () => {
      const handler = findHandler('workspaceTrust:decide')

      const result = await handler({} as never, {
        target: { kind: 'repo', repoId: 'repo-1' },
        scope: 'workspace',
        decision: 'trust'
      })

      expect(recordWorkspaceTrustDecisionMock).toHaveBeenCalledWith(store, {
        path: '/home/user/work/proj',
        scope: 'workspace',
        decision: 'trust',
        origin: 'intake'
      })
      expect(result).toEqual({ id: 'entry-1' })
    })

    it('computes scope:parent as dirname in main, never trusting a renderer-supplied path', async () => {
      const handler = findHandler('workspaceTrust:decide')

      await handler({} as never, {
        target: { kind: 'repo', repoId: 'repo-1' },
        scope: 'parent',
        decision: 'trust'
      })

      // The handler passes the resolved (non-parent) path through unchanged — `scope:'parent'`
      // is resolved to the dirname inside `recordWorkspaceTrustDecision` itself, not here, so a
      // double-dirname bug can never sneak in at this boundary.
      expect(recordWorkspaceTrustDecisionMock).toHaveBeenCalledWith(store, {
        path: '/home/user/work/proj',
        scope: 'parent',
        decision: 'trust',
        origin: 'intake'
      })
    })

    it('returns null and records nothing for an unresolvable target', async () => {
      const handler = findHandler('workspaceTrust:decide')

      const result = await handler({} as never, {
        target: { kind: 'repo', repoId: 'missing' },
        scope: 'workspace',
        decision: 'trust'
      })

      expect(result).toBeNull()
      expect(recordWorkspaceTrustDecisionMock).not.toHaveBeenCalled()
    })
  })

  describe('workspaceTrust:revoke', () => {
    it('revokes by entry id only', async () => {
      const handler = findHandler('workspaceTrust:revoke')

      const result = await handler({} as never, { entryId: 'entry-1' })

      expect(revokeWorkspaceTrustEntryMock).toHaveBeenCalledWith(store, 'entry-1')
      expect(result).toBe(true)
    })
  })
})
