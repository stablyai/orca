import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeChildProcess from 'node:child_process'

const { runCodexAppServerSessionMock } = vi.hoisted(() => ({
  runCodexAppServerSessionMock: vi.fn()
}))

vi.mock('../codex/codex-app-server-session', () => ({
  runCodexAppServerSession: runCodexAppServerSessionMock
}))

// Why: the probe spawns a real login shell, and `resolveRelayGrokHome` swallows every
// spawn failure into its fallback. Left unmocked this asserts the runner's scheduling
// latency, not the parser: on a loaded sharded CI box the 8s timeout expires and the
// first case silently flips to the fallback path.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, execFile: vi.fn() }
})

const { execFile } = await import('node:child_process')
const execFileMock = vi.mocked(execFile)
const { execFile: actualExecFile } =
  await vi.importActual<typeof NodeChildProcess>('node:child_process')
const { installManagedHooks, resolveRelayCodexHome, resolveRelayGrokHome } =
  await import('./managed-hook-runtime')

type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

function stubProbeOutput(stdout: string): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    ;(args.at(-1) as ExecFileCallback)(null, { stdout, stderr: '' })
    return undefined
  }) as unknown as typeof execFile)
}

function stubProbeFailure(error: Error): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    ;(args.at(-1) as ExecFileCallback)(error)
    return undefined
  }) as unknown as typeof execFile)
}

beforeEach(() => {
  execFileMock.mockReset()
  runCodexAppServerSessionMock.mockReset()
  // Why: `installManagedHooks` proves a skipped probe through the login-shell run log, so the
  // probe must really spawn unless a case above stubs it. The mock loses `promisify.custom`,
  // so the real `(error, stdout, stderr)` callback is reshaped into the `{ stdout, stderr }`
  // that `promisify(execFile)` resolves in production.
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as ExecFileCallback
    return (actualExecFile as (...callArgs: unknown[]) => unknown)(
      ...args.slice(0, -1),
      (error: Error | null, stdout: string, stderr: string) => callback(error, { stdout, stderr })
    )
  }) as unknown as typeof execFile)
})

function stubCodexHomeProbe(codexHome: unknown): void {
  runCodexAppServerSessionMock.mockImplementation(
    async (
      _invocation: unknown,
      body: (_rpc: unknown, initializeResult: unknown) => Promise<unknown>
    ) => body({}, { codexHome })
  )
}

const tempHomes: string[] = []
const tempRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
const SHELL_NAME = 'login-shell'
const SHELL_RUNS_NAME = 'login-shell-runs'

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tempRoot, 'orca-managed-hook-runtime-'))
  tempHomes.push(home)
  return home
}

/** Login shell that records each invocation, so a skipped GROK_HOME probe is observable. */
async function stubLoginShell(home: string): Promise<void> {
  const shell = join(home, SHELL_NAME)
  await writeFile(
    shell,
    `#!/bin/sh\necho ran >> "${join(home, SHELL_RUNS_NAME)}"\nexit 0\n`,
    'utf8'
  )
  await chmod(shell, 0o755)
  vi.stubEnv('HOME', home)
  vi.stubEnv('SHELL', shell)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.runIf(process.platform !== 'win32')('resolveRelayGrokHome', () => {
  it('uses the login-shell GROK_HOME and normalizes trailing separators', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('/srv/grok///\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const [shell, args] = execFileMock.mock.calls[0] ?? []
    expect(shell).toBe('/bin/sh')
    // `sh`/`dash` reject `-lc`, so the mode choice is part of the contract under test.
    expect(args?.[0]).toBe('-c')
  })

  it('passes -lc to a login shell that supports it', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    stubProbeOutput('/srv/grok\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const [shell, args] = execFileMock.mock.calls[0] ?? []
    expect(shell).toBe('/bin/zsh')
    expect(args?.[0]).toBe('-lc')
  })

  it('falls back when the login-shell GROK_HOME is not an absolute POSIX path', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('../relative\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })

  // Why: this is the branch that made the old test flaky — pin it so a probe failure is
  // an asserted fallback rather than an invisible substitution for a real answer.
  it('falls back when the probe fails or times out', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeFailure(Object.assign(new Error('spawn timed out'), { killed: true }))

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })
})

describe.runIf(process.platform !== 'win32')('resolveRelayCodexHome', () => {
  it('uses the wrapper-aware home reported by Codex app-server', async () => {
    stubCodexHomeProbe('/srv/codex///')

    await expect(resolveRelayCodexHome('/home/orca')).resolves.toBe('/srv/codex')
  })

  // Why these three are pinned together: each one on its own silently degrades
  // into the ~/.codex fallback, which reads as "not redirected" rather than as a
  // failure, so a regression here looks like success.
  it('asks Codex through a login shell, under the installer s home', async () => {
    vi.stubEnv('SHELL', '/bin/bash')
    stubCodexHomeProbe('/srv/codex')

    await expect(resolveRelayCodexHome('/home/orca')).resolves.toBe('/srv/codex')

    const [invocation] = runCodexAppServerSessionMock.mock.calls[0] ?? []
    // A launcher wrapper lives on the login shell's PATH only; this process's
    // PATH is a non-login SSH exec and never has ~/.local/bin on it.
    expect(invocation).toMatchObject({ command: '/bin/bash', cliPath: null })
    expect(invocation.args[0]).toBe('-lc')
    expect(invocation.args[1]).toMatch(/^exec codex .*app-server$/)
    // Parent and child must agree on which account is being configured...
    expect(invocation.env).toEqual({ HOME: '/home/orca' })
    // ...and Orca's own managed-account CODEX_HOME must not be read back.
    expect(invocation.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })

  it('passes -c to a login shell that rejects -lc', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubCodexHomeProbe('/srv/codex')

    await resolveRelayCodexHome('/home/orca')

    expect(runCodexAppServerSessionMock.mock.calls[0]?.[0].args[0]).toBe('-c')
  })

  it.each([
    undefined,
    '',
    'relative/home',
    '/valid\nsecond-line',
    'C:\\Users\\me\\.codex',
    '/',
    '//server/home',
    '/home/orca/../codex',
    '/home/orca/./codex',
    '/home//orca/codex'
  ])('falls back when app-server reports an invalid home: %s', async (codexHome) => {
    stubCodexHomeProbe(codexHome)

    await expect(resolveRelayCodexHome('/home/orca')).resolves.toBe('/home/orca/.codex')
  })

  it('falls back when the app-server probe fails or times out', async () => {
    runCodexAppServerSessionMock.mockRejectedValue(new Error('probe timed out'))

    await expect(resolveRelayCodexHome('/home/orca')).resolves.toBe('/home/orca/.codex')
  })
})

describe.runIf(process.platform !== 'win32')('installManagedHooks', () => {
  it.each([
    ['omitted', undefined],
    ['empty', { agents: [] }]
  ])(
    'writes nothing and runs no probe when the allowlist is %s (issue #11641)',
    async (_label, options) => {
      const home = await createTempHome()
      await stubLoginShell(home)

      await expect(installManagedHooks(options)).resolves.toEqual({ installers: 0, errors: 0 })

      // Why: no agent config home, no ~/.orca install lock, and no GROK_HOME login-shell probe.
      expect(await readdir(home)).toEqual([SHELL_NAME])
    }
  )

  it('still rejects an aborted request rather than resolving an empty summary', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      installManagedHooks({ signal: controller.signal, agents: [] })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('installs only the allowlisted agent, under the install lock', async () => {
    const home = await createTempHome()
    await stubLoginShell(home)

    await expect(installManagedHooks({ agents: ['claude'] })).resolves.toEqual({
      installers: 1,
      errors: 0
    })

    expect((await readdir(home)).sort()).toEqual(['.claude', '.orca', SHELL_NAME, SHELL_RUNS_NAME])
    expect(runCodexAppServerSessionMock).not.toHaveBeenCalled()
  })

  it('installs Codex hooks into the home reported by the launcher-aware probe', async () => {
    const home = await createTempHome()
    const codexHome = join(home, '.codex-openai')
    await stubLoginShell(home)
    stubCodexHomeProbe(codexHome)

    await expect(installManagedHooks({ agents: ['codex'] })).resolves.toEqual({
      installers: 1,
      errors: 0
    })

    await expect(readFile(join(codexHome, 'hooks.json'), 'utf8')).resolves.toContain(
      'codex-hook.sh'
    )
    await expect(stat(join(home, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
