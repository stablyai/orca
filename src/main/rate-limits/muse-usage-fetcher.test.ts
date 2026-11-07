import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { runProcess } from '@orca/process-host'
import { fetchMuseRateLimits } from './muse-usage-fetcher'

type ProcessSpec = Parameters<typeof runProcess>[0]
type ProcessResult = Awaited<ReturnType<typeof runProcess>>

const HELP_WITH_USAGE = `muse — interactive terminal coding agent

Usage: muse [OPTIONS] [PROMPT]

Commands:
  login            Log in to a provider
  usage            Show your subscription allowance
  init             Scaffold agent config in this workspace

Options:
  -h, --help  Print help
`

const HELP_WITHOUT_USAGE = HELP_WITH_USAGE.replace(
  '  usage            Show your subscription allowance\n',
  ''
)

function result(overrides: Partial<ProcessResult>): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

const USAGE_STDOUT =
  '{"schemaVersion":1,"allowance":{"tier":"Muse Code Everyday Usage","window":{"usedPercent":9,"resetsAtMs":1793961242000},"weekly":{"usedPercent":3,"resetsAtMs":1794182400000},"asOfMs":900,"source":"mint"},"reason":null,"hint":null}'

const installDirs: string[] = []

// Mirrors the launcher layout: `muse`, `.muse-version` and `muse-bin-<version>` side by side.
function launcherInstall(version: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-muse-')))
  installDirs.push(dir)
  writeFileSync(path.join(dir, 'muse'), '#!/usr/bin/env bash\n')
  writeFileSync(path.join(dir, '.muse-version'), `${version}\n`)
  writeFileSync(path.join(dir, `muse-bin-${version}`), '')
  chmodSync(path.join(dir, `muse-bin-${version}`), 0o755)
  return dir
}

afterEach(() => {
  for (const dir of installDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fetchWith(responses: Record<string, ProcessResult>, command = '/usr/local/bin/muse') {
  const runCommand = vi.fn(async (spec: ProcessSpec) => {
    const response = responses[(spec.args ?? []).join(' ')]
    if (!response) {
      throw new Error(`unexpected muse invocation: ${spec.args?.join(' ')}`)
    }
    return response
  })
  const pending = fetchMuseRateLimits({
    runCommand,
    resolveCommand: async () => command,
    resolveEnvironment: async () => ({ PATH: '/usr/local/bin', MUSE_LAUNCHER_INSTALL: '1' }),
    resolveCwd: () => '/tmp',
    now: () => 1000
  })
  return { runCommand, pending }
}

describe('fetchMuseRateLimits', () => {
  it('never sends `usage` to a Muse build whose help does not list it', async () => {
    const { runCommand, pending } = fetchWith({ '--help': result({ stdout: HELP_WITHOUT_USAGE }) })
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([['--help']])
  })

  it('gates on the launcher version file without spawning an older Muse', async () => {
    const dir = launcherInstall('1.4.12-R7001.1')
    const { runCommand, pending } = fetchWith({}, path.join(dir, 'muse'))
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('runs the versioned Muse binary directly instead of the launcher', async () => {
    const dir = launcherInstall('1.4.14-R7309.1')
    const { runCommand, pending } = fetchWith(
      { 'usage --json': result({ stdout: USAGE_STDOUT }) },
      path.join(dir, 'muse')
    )
    await expect(pending).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 9 } })
    expect(runCommand.mock.calls.map(([spec]) => [spec.program, spec.args])).toEqual([
      [path.join(dir, 'muse-bin-1.4.14-R7309.1'), ['usage', '--json']]
    ])
  })

  it('reads usage without auto-update or interactive sign-in', async () => {
    const { runCommand, pending } = fetchWith({
      '--help': result({ stdout: HELP_WITH_USAGE }),
      'usage --json': result({ stdout: USAGE_STDOUT })
    })
    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 9 },
      weekly: { usedPercent: 3 }
    })
    expect(runCommand.mock.calls[1]?.[0].env).toMatchObject({
      MUSE_NO_AUTO_UPDATE: '1',
      MUSE_LOGIN: '0',
      MUSE_LAUNCHER_INSTALL: '0'
    })
  })

  it('classifies a signed-out CLI as missing credentials', async () => {
    const { pending } = fetchWith({
      '--help': result({ stdout: HELP_WITH_USAGE }),
      'usage --json': result({ code: 1, stderr: 'not logged in: run `muse login` first\n' })
    })
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  })
})
