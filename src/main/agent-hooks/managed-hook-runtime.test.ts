import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeChildProcess from 'node:child_process'

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
const { installManagedHooks, resolveRelayGrokHome, resolveRelayRedirectedCodexHome } =
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
  })
})

describe.runIf(process.platform !== 'win32')('resolveRelayRedirectedCodexHome', () => {
  const CODEX_ONLY = ['codex'] as const

  it('reports the CODEX_HOME the host s own Codex names', async () => {
    // #19598: a launcher wrapper exports CODEX_HOME inside the script, so only
    // Codex itself knows. The login-shell environment never sees it.
    await expect(
      resolveRelayRedirectedCodexHome(
        '/home/orca',
        CODEX_ONLY,
        undefined,
        async () => '/home/orca/.codex-x/'
      )
    ).resolves.toBe('/home/orca/.codex-x')
  })

  // Why null rather than the path: an explicit codexHomeDir switches
  // installRemote to its redirected-runtime contract (script location, command
  // wrapper, hook order). An unwrapped host must keep the incumbent layout.
  it('reports no redirect when Codex names the ordinary home', async () => {
    await expect(
      resolveRelayRedirectedCodexHome(
        '/home/orca/',
        CODEX_ONLY,
        undefined,
        async () => '/home/orca/.codex'
      )
    ).resolves.toBeNull()
  })

  it('reports no redirect when Codex does not answer', async () => {
    await expect(
      resolveRelayRedirectedCodexHome('/home/orca', CODEX_ONLY, undefined, async () => null)
    ).resolves.toBeNull()
  })

  it.each([
    ['relative', '../relative'],
    ['Windows', 'C:\\Users\\bob\\.codex'],
    ['control-character', '/home/orca/.codex\u0007'],
    ['empty', '   ']
  ])('reports no redirect when the reported home is %s', async (_label, reported) => {
    await expect(
      resolveRelayRedirectedCodexHome('/home/orca', CODEX_ONLY, undefined, async () => reported)
    ).resolves.toBeNull()
  })

  it('does not probe for a host with no detected Codex', async () => {
    const probe = vi.fn()

    await expect(
      resolveRelayRedirectedCodexHome('/home/orca', ['claude'], undefined, probe)
    ).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform !== 'win32')(
  'installManagedHooks with a redirected Codex home',
  () => {
    /** A `codex` earlier on PATH that exports its own CODEX_HOME, as in #19598. */
    async function stubWrappedCodex(home: string, codexHome: string): Promise<void> {
      const binDir = join(home, 'bin')
      await mkdir(binDir, { recursive: true })
      const codexPath = join(binDir, 'codex')
      await writeFile(
        codexPath,
        `#!/bin/sh\nread -r _line\nprintf '%s\\n' '{"id":1,"result":{"codexHome":"${codexHome}"}}'\nsleep 5\n`,
        'utf8'
      )
      await chmod(codexPath, 0o755)
      vi.stubEnv('HOME', home)
      vi.stubEnv('SHELL', '/bin/sh')
      vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
    }

    it('installs into the home Codex reports, not ~/.codex', async () => {
      const home = await createTempHome()
      const codexHome = join(home, '.codex-openai')
      await stubWrappedCodex(home, codexHome)

      await expect(installManagedHooks({ agents: ['codex'] })).resolves.toEqual({
        installers: 1,
        errors: 0
      })

      await expect(readFile(join(codexHome, 'hooks.json'), 'utf8')).resolves.toContain(
        'codex-hook.sh'
      )
      await expect(readFile(join(home, '.codex', 'hooks.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })

    // The redirected-home contract moves the hook script under CODEX_HOME and
    // rewrites the command; an unwrapped host must keep the incumbent layout.
    it('leaves an unwrapped host on its incumbent ~/.codex layout', async () => {
      const home = await createTempHome()
      await stubWrappedCodex(home, join(home, '.codex'))

      await expect(installManagedHooks({ agents: ['codex'] })).resolves.toEqual({
        installers: 1,
        errors: 0
      })

      await expect(readFile(join(home, '.codex', 'hooks.json'), 'utf8')).resolves.toContain(
        join(home, '.orca', 'agent-hooks', 'codex-hook.sh')
      )
      await expect(
        readFile(join(home, '.codex', '.orca', 'agent-hooks', 'codex-hook.sh'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('moves the hook script under a redirected home, as the runtime installer does', async () => {
      const home = await createTempHome()
      const codexHome = join(home, '.codex-openai')
      await stubWrappedCodex(home, codexHome)

      await installManagedHooks({ agents: ['codex'] })

      await expect(
        readFile(join(codexHome, '.orca', 'agent-hooks', 'codex-hook.sh'), 'utf8')
      ).resolves.toContain('#!/bin/sh')
    })
  }
)
