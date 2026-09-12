import { expect, it, vi } from 'vitest'
import { createRuntimeRemoteManagedWorktree } from './runtime-remote-managed-worktree-create'

vi.mock('./runtime-remote-worktree-create-request', () => ({
  requestRuntimeRemoteWorktree: vi.fn(async () => ({
    worktree: { id: 'repo::remote', path: '/srv/remote' },
    setup: { runnerScriptPath: '/srv/setup.sh', envVars: {} },
    defaultTabs: { tabs: [{ title: 'Shell' }], runCommands: false }
  }))
}))

it('provisions paired SSH creates before addressed reveal without returning duplicate launch instructions', async () => {
  let finish!: (value: { setupSpawned: boolean; setupTerminalHandle: string }) => void
  const provision = vi.fn(
    () =>
      new Promise<{ setupSpawned: boolean; setupTerminalHandle: string }>((resolve) => {
        finish = resolve
      })
  )
  const activate = vi.fn()
  const pending = createRuntimeRemoteManagedWorktree(
    { id: 'repo', connectionId: 'ssh-a' } as never,
    {
      name: 'remote',
      activate: true,
      navigation: 'caller',
      workOrigin: { kind: 'paired-device', deviceId: 'a' }
    },
    {
      store: {} as never,
      canSpawn: () => true,
      provision,
      activate,
      createTerminal: vi.fn(),
      markTrusted: vi.fn(),
      pasteDraft: vi.fn(),
      sendFollowup: vi.fn(),
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyWorktreesChanged: vi.fn()
    }
  )
  await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce())
  expect(provision).toHaveBeenCalledWith(expect.objectContaining({ surfaceOwner: false }))
  expect(activate).not.toHaveBeenCalled()
  finish({ setupSpawned: true, setupTerminalHandle: 'setup' })
  const result = await pending
  expect(result.setup).toBeUndefined()
  expect(result.defaultTabs).toBeUndefined()
  expect(activate).toHaveBeenCalledWith('repo', 'repo::remote')
})
