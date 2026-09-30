import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { spawnAiVaultServiceProcess } = await import('./session-scanner-service-spawn')

function forkOptions(): { env?: NodeJS.ProcessEnv; execArgv?: string[] } {
  return forkMock.mock.calls.at(-1)?.[2] ?? {}
}

describe('spawnAiVaultServiceProcess', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: undefined } })
    forkMock.mockReset()
    forkMock.mockReturnValue({ pid: undefined, unref: vi.fn() } as unknown as ChildProcess)
  })

  it.each(['darwin', 'linux', 'win32'])('isolates Bun configuration on %s', (platform) => {
    vi.stubGlobal('process', {
      ...process,
      platform,
      versions: { ...process.versions, bun: '1.4.2' }
    })
    spawnAiVaultServiceProcess()
    expect(forkOptions().execArgv).toEqual([
      '--max-old-space-size=384',
      '--no-env-file',
      platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
      '--no-install'
    ])
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
