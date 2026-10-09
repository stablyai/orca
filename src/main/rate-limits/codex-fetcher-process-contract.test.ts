import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { npmProgNodeShim } from '../../shared/child-process/__fixtures__/windows-cmd-shim-bodies'
import type * as RunProcess from '../../shared/child-process/run-process'

const { ptySpawnMock, resolveCodexCommandMock, stubScript } = vi.hoisted(() => ({
  stubScript: { path: '', useResolvedCommand: false },
  ptySpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn()
}))

// Runs the node stub in place of the resolved CLI, through the real chokepoint.
vi.mock('../../shared/child-process/run-process', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  return {
    ...actual,
    spawnProcess: (spec: Parameters<typeof actual.spawnProcess>[0]) =>
      actual.spawnProcess(
        stubScript.useResolvedCommand
          ? spec
          : {
              ...spec,
              program: process.execPath,
              args: [stubScript.path, ...(spec.args ?? [])]
            }
      )
  }
})

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

vi.mock('../codex/codex-state-db', () => ({
  isCodexStateDbBackfillPending: vi.fn(() => false)
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))

import { fetchCodexRateLimits } from './codex-fetcher'

const STUB_CODEX_SOURCE = `
const expectedArgs = [
  '-c',
  'approval_policy=never',
  '-c',
  'features.plugins=false',
  '-s',
  'read-only',
  '-a',
  'never',
  'app-server'
]
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs)) {
  process.stderr.write(
    "error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'\\n" +
      '  [possible values: on-request, never]\\n'
  )
  process.exit(2)
}
if (process.env.CODEX_HOME !== process.env.ORCA_EXPECTED_CODEX_HOME) {
  process.stderr.write('managed CODEX_HOME was not preserved\\n')
  process.exit(3)
}
if (process.env.ORCA_EXPECT_LONG_PATH === '1' &&
    (process.env.Path ?? process.env.PATH ?? '').length <= 8191) {
  process.stderr.write('child PATH did not exceed the cmd.exe limit')
  process.exit(4)
}
let buffer = ''
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'codex-contract/0.149.0' } })
      continue
    }
    if (message.method === 'account/rateLimits/read') {
      send({
        id: message.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 17, windowDurationMins: 300 },
            secondary: { usedPercent: 29, windowDurationMins: 10080 }
          }
        }
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

let tempRoot: string
let stubPath: string
let previousExpectedHome: string | undefined

describe('Codex rate-limit process contract', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-codex-rate-limit-contract-'))
    stubPath = join(tempRoot, 'codex-contract.cjs')
    writeFileSync(stubPath, STUB_CODEX_SOURCE)
    previousExpectedHome = process.env.ORCA_EXPECTED_CODEX_HOME
    process.env.ORCA_EXPECTED_CODEX_HOME = join(tempRoot, 'managed-codex-home')
    resolveCodexCommandMock.mockReturnValue('codex')
    stubScript.path = stubPath
    stubScript.useResolvedCommand = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (previousExpectedHome === undefined) {
      delete process.env.ORCA_EXPECTED_CODEX_HOME
    } else {
      process.env.ORCA_EXPECTED_CODEX_HOME = previousExpectedHome
    }
    rmSync(tempRoot, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('starts a read-only non-interactive app-server with the managed home', async () => {
    await expect(
      fetchCodexRateLimits({
        codexHomePath: process.env.ORCA_EXPECTED_CODEX_HOME
      })
    ).resolves.toMatchObject({
      provider: 'codex',
      session: { usedPercent: 17, windowMinutes: 300 },
      weekly: { usedPercent: 29, windowMinutes: 10080 },
      status: 'ok',
      error: null
    })
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')(
    'reads usage through an npm shim with a long PATH',
    async () => {
      const shimPath = join(tempRoot, 'codex.cmd')
      writeFileSync(shimPath, npmProgNodeShim('codex-contract.cjs'))
      resolveCodexCommandMock.mockReturnValue(shimPath)
      stubScript.useResolvedCommand = true
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
      vi.stubEnv(
        pathKey,
        [dirname(process.execPath), ...Array(400).fill(join(tempRoot, 'unused'))].join(delimiter)
      )
      vi.stubEnv('ORCA_EXPECT_LONG_PATH', '1')

      await expect(
        fetchCodexRateLimits({ codexHomePath: process.env.ORCA_EXPECTED_CODEX_HOME })
      ).resolves.toMatchObject({
        provider: 'codex',
        session: { usedPercent: 17, windowMinutes: 300 },
        weekly: { usedPercent: 29, windowMinutes: 10080 },
        status: 'ok',
        error: null
      })
      expect(ptySpawnMock).not.toHaveBeenCalled()
    }
  )
})
