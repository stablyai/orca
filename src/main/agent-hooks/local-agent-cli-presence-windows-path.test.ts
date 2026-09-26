import { afterEach, describe, expect, it, vi } from 'vitest'

const { mergePath } = vi.hoisted(() => ({ mergePath: vi.fn() }))
vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePath,
  resolvePathEnvKey: (env: NodeJS.ProcessEnv) =>
    Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}))

import { detectLocalManagedAgentCliPresence } from './local-agent-cli-presence'

const targets = [
  { agent: 'antigravity', tuiAgent: 'antigravity', executableCandidates: ['agy'] }
] as const

afterEach(() => vi.resetAllMocks())

describe('managed hook detection after a Windows CLI install', () => {
  it('finds a new user PATH executable without changing the process environment', async () => {
    const inheritedPath = process.env.PATH
    mergePath.mockImplementation(async (env: NodeJS.ProcessEnv) => {
      const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
      env[key] = 'C:\\New Tools'
    })
    const result = await detectLocalManagedAgentCliPresence(
      targets,
      {},
      {
        platform: 'win32',
        pathExt: '.EXE',
        fileProbe: { isExecutableFile: async (file) => file === 'C:\\New Tools\\agy.EXE' }
      }
    )
    expect(result.antigravity).toEqual({ state: 'found', executablePath: 'C:\\New Tools\\agy.EXE' })
    expect(mergePath).toHaveBeenCalledWith(expect.any(Object), { forceRefresh: true })
    expect(process.env.PATH).toBe(inheritedPath)
  })

  it('keeps an explicitly supplied target PATH isolated from the local registry', async () => {
    const result = await detectLocalManagedAgentCliPresence(
      targets,
      {},
      {
        platform: 'win32',
        pathEnv: 'C:\\Target',
        pathExt: '.EXE',
        fileProbe: { isExecutableFile: async (file) => file === 'C:\\Target\\agy.EXE' }
      }
    )
    expect(result.antigravity?.state).toBe('found')
    expect(mergePath).not.toHaveBeenCalled()
  })

  it('does not consult the Windows registry for a POSIX host', async () => {
    await detectLocalManagedAgentCliPresence(
      targets,
      {},
      {
        platform: 'linux',
        fileProbe: { isExecutableFile: async () => false }
      }
    )
    expect(mergePath).not.toHaveBeenCalled()
  })
})
