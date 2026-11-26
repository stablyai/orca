import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as hydrateShellPath from './hydrate-shell-path'
import { withLaunchPath } from './hydrate-shell-path'
import { captureLoginShellEnvironment } from './login-shell-environment'

vi.mock('./hydrate-shell-path', async (actual) => {
  const module = await actual<typeof hydrateShellPath>()
  return { ...module, withLaunchPath: vi.fn(module.withLaunchPath) }
})

const launchPath = process.env.PATH
const originalHome = process.env.HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
let dir: string | null = null

// The pwsh on PATH, as an absolute login-shell path; null on Windows and where none is installed.
const realPwsh =
  process.platform === 'win32'
    ? null
    : spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '[Environment]::ProcessPath'], {
        encoding: 'utf8'
      }).stdout?.trim() || null

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  process.env.PATH = launchPath
  restoreEnv('HOME', originalHome)
  restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome)
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

it.skipIf(process.platform === 'win32')(
  'runs the profile on the launch PATH, so profile entries appear once',
  async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-login-shell-'))
    const rcBin = join(dir, 'rc-bin')
    const orcaSeeded = join(dir, 'orca-seeded-bin')
    const shell = join(dir, 'fake-shell')
    // Stands in for `zsh -ilc`: the "rc file" prepends rcBin, then the command runs.
    writeFileSync(shell, `#!/bin/sh\nexport PATH="${rcBin}:$PATH"\nexec /bin/sh -c "$2"\n`)
    chmodSync(shell, 0o755)
    // Startup hydration already merged the profile's entries and Orca's seeded dirs into process.env.
    process.env.PATH = [rcBin, launchPath, orcaSeeded].join(delimiter)

    const capture = await captureLoginShellEnvironment({ shellOverride: shell })

    expect(capture.status).toBe('captured')
    const segments = capture.env.PATH!.split(delimiter)
    expect(segments.filter((segment) => segment === rcBin)).toHaveLength(1)
    expect(segments[0]).toBe(rcBin)
    expect(segments).toContain(orcaSeeded)
  }
)

it.skipIf(process.platform === 'win32')('a cached read builds no probe env', async () => {
  vi.mocked(withLaunchPath).mockClear()
  const spawner = vi.fn(async () => ({ PATH: '/captured' }))
  const shellOverride = '/bin/cached-read-shell'
  expect((await captureLoginShellEnvironment({ shellOverride, spawner })).status).toBe('captured')
  expect(vi.mocked(withLaunchPath)).toHaveBeenCalledTimes(1)

  await captureLoginShellEnvironment({ shellOverride, spawner })
  await captureLoginShellEnvironment({ shellOverride, spawner, cachedOnly: true })
  expect(spawner).toHaveBeenCalledTimes(1)
  expect(vi.mocked(withLaunchPath)).toHaveBeenCalledTimes(1)
})

it.runIf(realPwsh !== null)(
  'captures a PowerShell profile export when pwsh is the login shell',
  async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-login-pwsh-env-'))
    mkdirSync(join(dir, '.config', 'powershell'), { recursive: true })
    writeFileSync(
      join(dir, '.config', 'powershell', 'profile.ps1'),
      "$env:ORCA_PWSH_PROFILE_ONLY = 'pwsh-profile'\n$env:Path = 'case-distinct'\n"
    )
    process.env.HOME = dir
    delete process.env.XDG_CONFIG_HOME

    // .NET cold start is slow on CI runners.
    const capture = await captureLoginShellEnvironment({
      shellOverride: realPwsh!,
      timeoutMs: 20_000
    })

    expect(capture.status).toBe('captured')
    expect(capture.env.ORCA_PWSH_PROFILE_ONLY).toBe('pwsh-profile')
    // Unix env names are case-sensitive: Path is its own variable beside PATH.
    expect(capture.env.Path).toBe('case-distinct')
    expect(capture.env.PATH).toContain('/')
  },
  30_000
)
