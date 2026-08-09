import { describe, expect, it, vi } from 'vitest'
import { resolveDebugAdapterProcessHost } from './debug-adapter-host-resolution'
import { LocalDebugAdapterProcessHost } from './debug-adapter-process-host'
import { SshDebugAdapterProcessHost } from './ssh-debug-adapter-process-host'

vi.mock('../local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimeForWorktreeId: vi.fn()
}))

describe('resolveDebugAdapterProcessHost', () => {
  it('picks SshDebugAdapterProcessHost with an ssh: hostId when connectionId is set', () => {
    const getSshConnection = vi.fn()
    const result = resolveDebugAdapterProcessHost({
      worktreeId: 'repo-a::/local/Triton',
      connectionId: 'ssh-conn-1',
      getSshConnection
    })
    expect(result.host).toBeInstanceOf(SshDebugAdapterProcessHost)
    expect(result.hostId).toBe('ssh:ssh-conn-1')
  })

  it('picks LocalDebugAdapterProcessHost with the local hostId when there is no connectionId', async () => {
    const { resolveLocalProjectRuntimeForWorktreeId } =
      await import('../local-project-runtime-resolution')
    vi.mocked(resolveLocalProjectRuntimeForWorktreeId).mockReturnValue(undefined)

    const result = resolveDebugAdapterProcessHost({
      worktreeId: 'repo-a::/local/Triton',
      connectionId: null,
      getSshConnection: vi.fn()
    })
    expect(result.host).toBeInstanceOf(LocalDebugAdapterProcessHost)
    expect(result.hostId).toBe('local')
  })
})
