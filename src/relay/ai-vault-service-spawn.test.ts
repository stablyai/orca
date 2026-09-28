import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))

const { spawnRelayAiVaultService } = await import('./ai-vault-service-spawn')

function forkOptions(): { env?: NodeJS.ProcessEnv; execArgv?: string[] } {
  return forkMock.mock.calls.at(-1)?.[2] ?? {}
}

describe('spawnRelayAiVaultService', () => {
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
    spawnRelayAiVaultService()
    expect(forkOptions().execArgv).toEqual([
      '--no-env-file',
      platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
      '--no-install'
    ])
  })

  it('keeps parent runtime flags and loaders out of the Bun sidecar', () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=8192 --require=/tmp/evil.js')
    spawnRelayAiVaultService()
    const options = forkOptions()

    // Asserted first: omitting `env` entirely inherits everything, and would
    // leave the NODE_OPTIONS assertion below passing for the wrong reason.
    expect(options.env).toBeDefined()
    expect(options.env?.NODE_OPTIONS).toBeUndefined()
    expect(options.execArgv).toEqual([])
    vi.unstubAllEnvs()
  })

  it('does not hand the sidecar the rest of the remote login environment', () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'shhh')
    spawnRelayAiVaultService()
    const options = forkOptions()

    expect(options.env).toBeDefined()
    expect(options.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    vi.unstubAllEnvs()
  })
})
