import { describe, expect, it, vi } from 'vitest'
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

function fetchWith(responses: Record<string, ProcessResult>) {
  const runCommand = vi.fn(async (spec: ProcessSpec) => {
    const response = responses[(spec.args ?? []).join(' ')]
    if (!response) {
      throw new Error(`unexpected muse invocation: ${spec.args?.join(' ')}`)
    }
    return response
  })
  const pending = fetchMuseRateLimits({
    runCommand,
    resolveCommand: async () => '/usr/local/bin/muse',
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

  it('reads usage without auto-update or interactive sign-in', async () => {
    const { runCommand, pending } = fetchWith({
      '--help': result({ stdout: HELP_WITH_USAGE }),
      'usage --json': result({
        stdout:
          '{"schemaVersion":1,"allowance":{"tier":"Muse Code Everyday Usage","window":{"usedPercent":9,"resetsAtMs":1793961242000},"weekly":{"usedPercent":3,"resetsAtMs":1794182400000},"asOfMs":900,"source":"mint"},"reason":null,"hint":null}'
      })
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
