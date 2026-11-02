import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ProbeResult = { code: number | null; stdout: string; timedOut: boolean }
type RunProcessStub = (spec: { program: string; args: string[] }) => Promise<ProbeResult>

// Why: the probe spawns a real login shell and swallows every spawn failure into its fallback.
// Left unmocked this asserts the runner's scheduling latency, not the parser: on a loaded CI box
// the 8s timeout expires and the first case silently flips to the fallback path.
const probe = vi.hoisted(() => ({ runProcess: vi.fn<RunProcessStub>() }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: probe.runProcess
}))

const probeMock = probe.runProcess
const { adoptLoginShellAgentHomes, resolveLoginShellGrokHome, resolveLoginShellKiroHome } =
  await import('./agent-home-login-shell')

function stubProbeOutput(stdout: string | ((script: string) => string)): void {
  probeMock.mockImplementation(async ({ args }) => ({
    code: 0,
    timedOut: false,
    stdout: typeof stdout === 'string' ? stdout : stdout(args[1] ?? '')
  }))
}

function stubProbeFailure(error: Error & { killed?: boolean }): void {
  probeMock.mockImplementation(async () => {
    if (error.killed) {
      return { code: null, timedOut: true, stdout: '' }
    }
    throw error
  })
}

beforeEach(() => {
  probeMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.runIf(process.platform !== 'win32')('resolveLoginShellGrokHome', () => {
  it('uses the login-shell GROK_HOME and normalizes trailing separators', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('/srv/grok///\n')

    await expect(resolveLoginShellGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const { program: shell, args } = probeMock.mock.calls[0]?.[0] ?? {}
    expect(shell).toBe('/bin/sh')
    // `sh`/`dash` reject `-lc`, so the mode choice is part of the contract under test.
    expect(args?.[0]).toBe('-c')
  })

  it('passes -lc to a login shell that supports it', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    stubProbeOutput('/srv/grok\n')

    await expect(resolveLoginShellGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const { program: shell, args } = probeMock.mock.calls[0]?.[0] ?? {}
    expect(shell).toBe('/bin/zsh')
    expect(args?.[0]).toBe('-lc')
  })

  it('falls back when the login-shell GROK_HOME is not an absolute POSIX path', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('../relative\n')

    await expect(resolveLoginShellGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })

  // Why: this is the branch that made the old test flaky — pin it so a probe failure is
  // an asserted fallback rather than an invisible substitution for a real answer.
  it('falls back when the probe fails or times out', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeFailure(Object.assign(new Error('spawn timed out'), { killed: true }))

    await expect(resolveLoginShellGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })
})

describe.runIf(process.platform !== 'win32')('resolveLoginShellKiroHome', () => {
  it('reads KIRO_HOME from the login shell', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('/srv/kiro/\n')

    await expect(resolveLoginShellKiroHome('/home/orca')).resolves.toBe('/srv/kiro')
    expect(probeMock.mock.calls[0]?.[0].args[1]).toContain('printenv KIRO_HOME')
  })

  it('falls back to ~/.kiro when KIRO_HOME is unset or the probe fails', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('\n')
    await expect(resolveLoginShellKiroHome('/home/orca')).resolves.toBe('/home/orca/.kiro')

    stubProbeFailure(new Error('spawn failed'))
    await expect(resolveLoginShellKiroHome('/home/orca')).resolves.toBe('/home/orca/.kiro')
  })
})

describe.runIf(process.platform !== 'win32')('adoptLoginShellAgentHomes', () => {
  it('adopts profile-only agent homes and keeps ones already set', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    stubProbeOutput((script) => (script.includes('KIRO_HOME') ? '/srv/kiro\n' : '/srv/grok\n'))
    const env: NodeJS.ProcessEnv = { GROK_HOME: '/already/grok' }

    await adoptLoginShellAgentHomes(env)

    expect(env).toEqual({ GROK_HOME: '/already/grok', KIRO_HOME: '/srv/kiro' })
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the environment alone when the login shell has no override', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    stubProbeOutput('\n')
    const env: NodeJS.ProcessEnv = {}

    await adoptLoginShellAgentHomes(env)

    expect(env).toEqual({})
  })
})
