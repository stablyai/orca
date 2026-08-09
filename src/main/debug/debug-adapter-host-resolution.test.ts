import { describe, expect, it, vi } from 'vitest'
import type { DebugAdapterConfig } from '../../shared/debug-session-types'
import { resolveDebugAdapterProcessHost } from './debug-adapter-host-resolution'
import { LocalDebugAdapterProcessHost } from './debug-adapter-process-host'
import {
  LocalJsDebugAdapterProcessHost,
  SshJsDebugAdapterProcessHost
} from './js-debug-adapter-process-host'
import { SshDebugAdapterProcessHost } from './ssh-debug-adapter-process-host'

vi.mock('../local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimeForWorktreeId: vi.fn()
}))

const NODE_CONFIG: DebugAdapterConfig = { type: 'node', request: 'launch', command: '', args: [] }
// Simulates a future stdio-transport adapter type (e.g. Wave 2's debugpy) to
// prove non-js-debug types still route through the plain stdio host.
const FUTURE_STDIO_CONFIG = {
  type: 'python',
  request: 'launch',
  command: '',
  args: []
} as unknown as DebugAdapterConfig

describe('resolveDebugAdapterProcessHost', () => {
  it('resolves an ssh: hostId when connectionId is set, dispatching node/chrome configs through SshJsDebugAdapterProcessHost', async () => {
    const jsDebugSpawn = vi
      .spyOn(SshJsDebugAdapterProcessHost.prototype, 'spawn')
      .mockResolvedValue({} as never)
    const stdioSpawn = vi
      .spyOn(SshDebugAdapterProcessHost.prototype, 'spawn')
      .mockResolvedValue({} as never)
    try {
      const result = resolveDebugAdapterProcessHost({
        worktreeId: 'repo-a::/local/Triton',
        connectionId: 'ssh-conn-1',
        getSshConnection: vi.fn()
      })
      expect(result.hostId).toBe('ssh:ssh-conn-1')

      await result.host.spawn(NODE_CONFIG)
      expect(jsDebugSpawn).toHaveBeenCalledTimes(1)
      expect(stdioSpawn).not.toHaveBeenCalled()

      await result.host.spawn(FUTURE_STDIO_CONFIG)
      expect(stdioSpawn).toHaveBeenCalledTimes(1)
      expect(jsDebugSpawn).toHaveBeenCalledTimes(1)
    } finally {
      jsDebugSpawn.mockRestore()
      stdioSpawn.mockRestore()
    }
  })

  it('resolves the local hostId when there is no connectionId, dispatching node/chrome configs through LocalJsDebugAdapterProcessHost', async () => {
    const { resolveLocalProjectRuntimeForWorktreeId } =
      await import('../local-project-runtime-resolution')
    vi.mocked(resolveLocalProjectRuntimeForWorktreeId).mockReturnValue(undefined)
    const jsDebugSpawn = vi
      .spyOn(LocalJsDebugAdapterProcessHost.prototype, 'spawn')
      .mockResolvedValue({} as never)
    const stdioSpawn = vi
      .spyOn(LocalDebugAdapterProcessHost.prototype, 'spawn')
      .mockResolvedValue({} as never)
    try {
      const result = resolveDebugAdapterProcessHost({
        worktreeId: 'repo-a::/local/Triton',
        connectionId: null,
        getSshConnection: vi.fn()
      })
      expect(result.hostId).toBe('local')

      await result.host.spawn(NODE_CONFIG)
      expect(jsDebugSpawn).toHaveBeenCalledTimes(1)
      expect(stdioSpawn).not.toHaveBeenCalled()

      await result.host.spawn(FUTURE_STDIO_CONFIG)
      expect(stdioSpawn).toHaveBeenCalledTimes(1)
      expect(jsDebugSpawn).toHaveBeenCalledTimes(1)
    } finally {
      jsDebugSpawn.mockRestore()
      stdioSpawn.mockRestore()
    }
  })
})
