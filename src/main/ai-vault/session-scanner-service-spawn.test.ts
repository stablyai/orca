import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { spawnAiVaultServiceProcess } = await import('./session-scanner-service-spawn')

function forkOptions(): { env?: NodeJS.ProcessEnv; execArgv?: string[] } {
  return forkMock.mock.calls.at(-1)?.[2] ?? {}
}

describe('spawnAiVaultServiceProcess', () => {
  beforeEach(() => {
    forkMock.mockReset()
    forkMock.mockReturnValue({ pid: undefined, unref: vi.fn() } as unknown as ChildProcess)
  })

  it('keeps NODE_OPTIONS out of the child so the heap cap and loader stand', () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=8192 --require=/tmp/evil.js')
    spawnAiVaultServiceProcess()
    const options = forkOptions()

    // Asserted first: omitting `env` entirely inherits everything, and would
    // leave the NODE_OPTIONS assertion below passing for the wrong reason.
    expect(options.env).toBeDefined()
    expect(options.env?.NODE_OPTIONS).toBeUndefined()
    expect(options.execArgv).toEqual(['--max-old-space-size=384'])
    vi.unstubAllEnvs()
  })

  it('still passes through a relocated agent home', () => {
    vi.stubEnv('CODEX_HOME', '/home/dev/elsewhere/.codex')
    spawnAiVaultServiceProcess()

    expect(forkOptions().env?.CODEX_HOME).toBe('/home/dev/elsewhere/.codex')
    vi.unstubAllEnvs()
  })

  it('runs the forked Electron binary as plain Node', () => {
    spawnAiVaultServiceProcess()

    expect(forkOptions().env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
