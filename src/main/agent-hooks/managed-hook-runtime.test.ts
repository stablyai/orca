import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { installManagedHooks, resolveRelayGrokHome } = await import('./managed-hook-runtime')

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

/** A probe shell named after a real shell, so the `-c` / `-lc` choice this
 *  module derives from the basename is exercised rather than asserted on a mock.
 *  Why a stub and not the user's shell: the probe swallows every failure into
 *  its fallback, so a slow real login shell would silently assert nothing. */
async function stubGrokShell(
  home: string,
  { shellName, printed }: { shellName: string; printed: string | null }
): Promise<void> {
  const shell = join(home, shellName)
  // Why `printf '%s\\n'`: sh's `%s` does not interpret an escape, so a newline
  // has to come from the format string for the first-line read to be exercised.
  const body = printed === null ? 'exit 1' : `printf '%s\\n' ${JSON.stringify(printed)}`
  await writeFile(shell, `#!/bin/sh\necho "$1" >> "${join(home, 'probe-flag')}"\n${body}\n`, 'utf8')
  await chmod(shell, 0o755)
  vi.stubEnv('SHELL', shell)
}

async function readProbeFlag(home: string): Promise<string> {
  return (await readFile(join(home, 'probe-flag'), 'utf8')).trim()
}

describe.runIf(process.platform !== 'win32')('resolveRelayGrokHome', () => {
  it('uses the login-shell GROK_HOME and normalizes trailing separators', async () => {
    const home = await createTempHome()
    await stubGrokShell(home, { shellName: 'sh', printed: '/srv/grok///' })

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    // `sh`/`dash` reject `-lc`, so the mode choice is part of the contract under test.
    expect(await readProbeFlag(home)).toBe('-c')
  })

  it('passes -lc to a login shell that supports it', async () => {
    const home = await createTempHome()
    await stubGrokShell(home, { shellName: 'zsh', printed: '/srv/grok' })

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    expect(await readProbeFlag(home)).toBe('-lc')
  })

  it('falls back when the login-shell GROK_HOME is not an absolute POSIX path', async () => {
    const home = await createTempHome()
    await stubGrokShell(home, { shellName: 'sh', printed: '../relative' })

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })

  // Why: pin the failure branch, so a probe failure is an asserted fallback
  // rather than an invisible substitution for a real answer.
  it('falls back when the probe exits non-zero', async () => {
    const home = await createTempHome()
    await stubGrokShell(home, { shellName: 'sh', printed: null })

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
