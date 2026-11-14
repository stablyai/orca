import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcess from '@orca/process-host'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'

const { ptySpawnMock, resolveCodexCommandMock, stubScript } = vi.hoisted(() => ({
  stubScript: { path: '' },
  ptySpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn()
}))

// Run the Node fixture through the real process chokepoint; worker transport has separate coverage.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  () =>
    import('../../../worker-thread-child-process/worker-thread-child-process-in-process.test-fixtures')
)
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  return {
    ...actual,
    spawnProcess: (spec: Parameters<typeof actual.spawnProcess>[0]) =>
      actual.spawnProcess({
        ...spec,
        program: process.execPath,
        args: [stubScript.path, ...(spec.args ?? [])]
      })
  }
})

vi.mock('../../../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

vi.mock('../../../codex/history/index/codex-state-db', () => ({
  isCodexStateDbBackfillPending: vi.fn(() => false)
}))

vi.mock('../../../codex/history/index/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))

import { fetchCodexRateLimits } from './codex-fetcher'

// Wait for initialization bytes before exiting so stderr diagnosis cannot race an EPIPE.
const STUB_CODEX_SOURCE = `
process.stdin.on('data', () => {
  process.stderr.write(process.env.ORCA_STUB_CODEX_STDERR ?? '')
  process.exit(Number(process.env.ORCA_STUB_CODEX_EXIT_CODE ?? '1'))
})
`

let tempRoot: string
let stubPath: string

function runStub(stderr: string, exitCode: number): Promise<{ error: string | null }> {
  process.env.ORCA_STUB_CODEX_STDERR = stderr
  process.env.ORCA_STUB_CODEX_EXIT_CODE = String(exitCode)
  // Empty fixture auth keeps HTTP fallback away from the developer's real login.
  return fetchCodexRateLimits({ codexHomePath: tempRoot })
}

describe('Codex RPC exit diagnostics', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-codex-rpc-exit-'))
    stubPath = join(tempRoot, 'codex-exit-stub.cjs')
    writeFileSync(stubPath, STUB_CODEX_SOURCE)
    resolveCodexCommandMock.mockReturnValue('codex')
    stubScript.path = stubPath
  })

  afterEach(() => {
    delete process.env.ORCA_STUB_CODEX_STDERR
    delete process.env.ORCA_STUB_CODEX_EXIT_CODE
    rmSync(tempRoot, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('keeps the re-auth phrase that path redaction would swallow', async () => {
    const result = await runStub(
      `ERROR: /Users/haris/.codex/auth.json is stale — please sign in again.\n`,
      1
    )

    expect(isCodexAuthError(result.error)).toBe(true)
  })

  it('redacts paths and secrets a dying child prints, and bounds the line', async () => {
    const result = await runStub(
      `ERROR: could not read /Users/moveoplus/.codex/auth.json (token=sk-${'a'.repeat(40)})\n` +
        `${'x'.repeat(5_000)}\n`,
      3
    )

    expect(result.error).not.toContain('moveoplus')
    expect(result.error).not.toContain('sk-aaaa')
    expect(result.error?.length ?? 0).toBeLessThan(500)
  })
})
