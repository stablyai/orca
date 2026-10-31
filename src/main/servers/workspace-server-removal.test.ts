import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceServerProcessManager } from './workspace-server-process-manager'
import {
  stopWorkspaceServersForRemoval,
  withWorkspaceServerRemoval
} from './workspace-server-removal'

const managers: WorkspaceServerProcessManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
})
function fixture() {
  const spawn = vi.fn(() => {
    throw new Error('fixture start failure')
  })
  const manager = new WorkspaceServerProcessManager(spawn)
  managers.push(manager)
  const start = (id: string, permit?: ReturnType<typeof manager.beginStart>) =>
    manager.start(
      { worktreeId: id, port: 4008, name: 'test' },
      { program: 'unused', cwd: '/tmp' },
      permit
    )
  return { manager, start, spawn }
}
it('revokes pending starts across a completed removal and admits a fresh retry', async () => {
  const { manager, start, spawn } = fixture()
  const permit = manager.beginStart()
  expect(manager.hasActiveServers()).toBe(true)
  await withWorkspaceServerRemoval({ workspaceServers: manager }, 'a', 'local', async () => {
    expect(() => start('a')).toThrow('removal')
    start('b', permit)
  })
  expect(() => start('a', permit)).toThrow('removed')
  expect(spawn).toHaveBeenCalledTimes(1)
  permit.release()
  start('a')
  expect(manager.hasActiveServers()).toBe(false)
})
it('keeps nested removals fenced until the final owner releases', async () => {
  const { manager, start } = fixture()
  const outer = manager.beginWorktreeRemoval('a')
  const inner = manager.beginWorktreeRemoval('a')
  outer()
  outer()
  expect(() => start('a')).toThrow('removal')
  inner()
  expect(() => start('a')).not.toThrow()
})
it('does not fence or stop a local same-ID twin when forgetting an off-host workspace', async () => {
  const { manager, start } = fixture()
  const stop = vi.spyOn(manager, 'stopWorktree')
  const permit = manager.beginStart()
  await withWorkspaceServerRemoval({ workspaceServers: manager }, 'a', 'ssh:remote', async () => {
    await stopWorkspaceServersForRemoval({ workspaceServers: manager }, 'a', 'ssh:remote')
    start('a', permit)
  })
  expect(stop).not.toHaveBeenCalled()
  permit.release()
})
it('awaits owned server termination and propagates failure before metadata removal', async () => {
  const { manager } = fixture()
  const stopping = Promise.withResolvers<void>()
  vi.spyOn(manager, 'stopWorktree').mockReturnValue(stopping.promise)
  const purge = vi.fn()
  const removal = withWorkspaceServerRemoval(
    { workspaceServers: manager },
    'a',
    'local',
    async () => {
      await stopWorkspaceServersForRemoval({ workspaceServers: manager }, 'a')
      purge()
    }
  )
  expect(purge).not.toHaveBeenCalled()
  const rejected = expect(removal).rejects.toThrow('termination unverified')
  stopping.reject(new Error('termination unverified'))
  await rejected
  expect(purge).not.toHaveBeenCalled()
})

it('revokes a start admitted during removal even after the removal has completed', () => {
  const { manager, start } = fixture()
  const release = manager.beginWorktreeRemoval('a')
  const permit = manager.beginStart()
  release()
  expect(() => start('a', permit)).toThrow('removed')
  permit.release()
})
