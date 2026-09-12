import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { materializeSshWorktreePaths } from '../ipc/ssh-worktree-path-materialization'

function providerWithCapabilities(capabilities: Record<string, unknown>) {
  const mux = {
    onNotification: vi.fn().mockReturnValue(() => {}),
    request: vi.fn(async (method: string) =>
      method === 'fs.getCapabilities' ? capabilities : { supported: true }
    )
  }
  return { mux, provider: new SshFilesystemProvider('test-host', mux as never) }
}

describe('SSH worktree materialization compatibility', () => {
  it('does not send the new method to an older host', async () => {
    const { provider, mux } = providerWithCapabilities({})
    expect(await provider.materializeWorktreePaths('/remote/source', '/remote/target', [])).toEqual(
      { supported: false }
    )
    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(
      await materializeSshWorktreePaths(provider, '/remote/source', '/remote/target', [])
    ).toContain('Update the host')
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('dispatches host paths without reading them on the client', async () => {
    const { provider, mux } = providerWithCapabilities({ worktreeMaterializationVersion: 1 })
    expect(
      await materializeSshWorktreePaths(provider, '/remote/source', '/remote/target', ['deps'])
    ).toBeUndefined()
    expect(mux.request).toHaveBeenLastCalledWith(
      'fs.materializeWorktreePaths',
      {
        source: '/remote/source',
        target: '/remote/target',
        linkedPaths: ['deps']
      },
      { timeoutMs: 300_000 }
    )
  })

  it('treats lost contact as unverifiable without retrying or running locally', async () => {
    const { provider, mux } = providerWithCapabilities({ worktreeMaterializationVersion: 1 })
    mux.request.mockRejectedValue(new Error('connection closed'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        materializeSshWorktreePaths(provider, '/remote/source', '/remote/target', [])
      ).rejects.toThrow('unverifiable')
      expect(mux.request).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })
})
