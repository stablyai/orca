import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveMultiplexer: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./ipc/ssh', () => ({
  getActiveMultiplexer: mocks.getActiveMultiplexer
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

const { markRemoteAgentWorkspaceTrusted } = await import('./remote-agent-trust-presets')

function makeFsProvider(overrides: Record<string, unknown> = {}) {
  return {
    realpath: vi.fn(async (path: string) => `/real${path}`),
    readFile: vi.fn(async () => ({ content: '', isBinary: false })),
    createDir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => {
      throw new Error('missing')
    }),
    ...overrides
  }
}

describe('markRemoteAgentWorkspaceTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: '/home/u/' }))
    })
  })

  it('writes Codex trust to the remote home and canonicalized workspace path', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(mocks.getActiveMultiplexer).toHaveBeenCalledWith('ssh-1')
    expect(fsProvider.realpath).toHaveBeenCalledWith('/repo/worktree')
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex/config.toml',
      expect.stringContaining('[projects."/real/repo/worktree"]')
    )
  })

  it('writes Cursor trust marker on the remote host', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.cursor/projects/real-repo-worktree')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.cursor/projects/real-repo-worktree/.workspace-trusted',
      expect.stringContaining('"workspacePath": "/real/repo/worktree"')
    )
  })

  it('appends Copilot trusted folder remotely without clobbering config keys', async () => {
    const writeFile = vi.fn(async (_filePath: string, _content: string) => undefined)
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ firstLaunchAt: '2026-01-01', trustedFolders: ['/old'] }),
        isBinary: false
      })),
      writeFile
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'copilot',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.copilot')
    const written = writeFile.mock.calls[0]?.[1]
    expect(typeof written).toBe('string')
    expect(JSON.parse(written as string)).toEqual({
      firstLaunchAt: '2026-01-01',
      trustedFolders: ['/old', '/real/repo/worktree']
    })
  })

  it('does nothing when the SSH home cannot be resolved safely', async () => {
    const fsProvider = makeFsProvider()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'relative/home' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })
})
