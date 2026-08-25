import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, getTerminalHandleMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  getTerminalHandleMock: vi.fn()
}))

vi.mock('../runtime-client', async () => {
  // Why: re-export the REAL error classes so format.ts `instanceof` narrowing still matches.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

vi.mock('../selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTerminalHandle: getTerminalHandleMock
}))

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

describe('orchestration moa commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.ORCA_TERMINAL_HANDLE
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
    process.exitCode = 0
  })

  const paramsFor = (method: string): Record<string, unknown> =>
    callMock.mock.calls.find((call) => call[0] === method)?.[1] as Record<string, unknown>

  it('builds a single entry from typed flags and carries the caller handle', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    queueFixtures(
      callMock,
      okFixture('req_show', { terminal: { handle: 'term_coord' } }),
      okFixture('req_moa', {
        deliberation: { id: 'd1', run_id: 'run_1' },
        inserted: 1,
        duplicates: 0
      })
    )

    await main(
      [
        'orchestration',
        'moa-log',
        '--deliberation',
        'd1',
        '--kind',
        'verdict',
        '--round',
        '2',
        '--seat',
        'seat-A',
        '--verdict',
        'support',
        '--rationale',
        'holds up',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(0)
    expect(paramsFor('orchestration.moaLog')).toEqual(
      expect.objectContaining({
        deliberation: 'd1',
        from: 'term_coord',
        entries: [
          { kind: 'verdict', round: 2, seat: 'seat-A', verdict: 'support', rationale: 'holds up' }
        ]
      })
    )
  })

  it('reads a batch from --entries-file', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const dir = mkdtempSync(join(tmpdir(), 'orca-moa-cli-'))
    const file = join(dir, 'entries.json')
    writeFileSync(
      file,
      JSON.stringify([
        { kind: 'proposal', seat: 'seat-A' },
        { kind: 'proposal', seat: 'seat-B' }
      ])
    )
    try {
      queueFixtures(
        callMock,
        okFixture('req_show', { terminal: { handle: 'term_coord' } }),
        okFixture('req_moa', {
          deliberation: { id: 'd1', run_id: 'run_1' },
          inserted: 2,
          duplicates: 0
        })
      )

      await main(
        ['orchestration', 'moa-log', '--deliberation', 'd1', '--entries-file', file, '--json'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      const params = paramsFor('orchestration.moaLog')
      expect(params.entries).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects combining --entries-file with single-entry flags', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    queueFixtures(callMock, okFixture('req_show', { terminal: { handle: 'term_coord' } }))

    await main(
      [
        'orchestration',
        'moa-log',
        '--deliberation',
        'd1',
        '--entries-file',
        'x.json',
        '--kind',
        'note',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.some((call) => call[0] === 'orchestration.moaLog')).toBe(false)
  })

  it('inspects a named run without resolving a caller terminal', async () => {
    queueFixtures(
      callMock,
      okFixture('req_moa', {
        runId: 'run_1',
        deliberations: [{ id: 'd1', task_id: null, seat_count: 3, created_at: '2026-08-25' }],
        count: 1
      })
    )

    await main(['orchestration', 'moa-show', '--run', 'run_1', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(0)
    expect(paramsFor('orchestration.moaShow')).toEqual(
      expect.objectContaining({ run: 'run_1', from: undefined })
    )
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })
})
