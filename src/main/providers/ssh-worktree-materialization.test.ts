import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { materializeSshWorktreePaths } from '../ipc/ssh-worktree-path-materialization'

function providerWithCapabilities(capabilities: Record<string, unknown>) {
  const mux = new SshChannelMultiplexer({ write: vi.fn(), onData: vi.fn(), onClose: vi.fn() })
  const request = vi
    .spyOn(mux, 'request')
    .mockImplementation(async (method) =>
      method === 'fs.getCapabilities' ? capabilities : { supported: true }
    )
  return { mux: { request }, provider: new SshFilesystemProvider('test-host', mux) }
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

  it('does not downgrade personal copies on a v1 host and caches the capability probe', async () => {
    const { provider, mux } = providerWithCapabilities({ worktreeMaterializationVersion: 1 })
    const result = await provider.materializeWorktreePaths(
      '/source',
      '/target',
      ['legacy'],
      ['.env']
    )
    expect(result.warning).toContain('needs an update')
    expect(mux.request).toHaveBeenLastCalledWith(
      'fs.materializeWorktreePaths',
      { source: '/source', target: '/target', linkedPaths: ['legacy'] },
      { timeoutMs: 300_000 }
    )
    await provider.materializeWorktreePaths('/source', '/target2', [], ['.env'])
    expect(
      mux.request.mock.calls.filter(([method]) => method === 'fs.getCapabilities')
    ).toHaveLength(1)
  })

  it('sends explicit private selections only to a capable host', async () => {
    const { provider, mux } = providerWithCapabilities({ worktreeMaterializationVersion: 2 })
    expect(await provider.materializeWorktreePaths('/source', '/target', [], ['.env'])).toEqual({
      supported: true
    })
    expect(mux.request).toHaveBeenLastCalledWith(
      'fs.materializeWorktreePaths',
      { source: '/source', target: '/target', linkedPaths: [], copyPaths: ['.env'] },
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
