import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
import { readFreshProcessTable, readProcessIdentities } from './pty-process-table-reader'

const start = 'Mon Jul 13 12:54:47 2026'
function respond(output: string, elapsedMs = 0) {
  runProcessMock.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + elapsedMs)
    return { code: 0, stdout: output }
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-14T12:00:00Z'))
  runProcessMock.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('bounded Codex command capture', () => {
  it('reads argv only for Codex process-group leaders with the remaining deadline', async () => {
    const boundary = Date.now()
    respond(
      [
        `10 1 10 ${start} /bin/zsh`,
        `20 10 10 ${start} /opt/bin/codex`,
        `30 20 30 ${start} /opt/bin/codex`,
        `40 20 40 ${start} /bin/node`
      ].join('\n'),
      200
    )
    respond(`30 20 30 ${start} /opt/bin/codex app-server --listen unix:// --managed-daemon`)
    const capture = await readFreshProcessTable(1000)
    expect(capture.capturedAtMs).toBe(boundary)
    expect(runProcessMock.mock.calls[0][0].args).toEqual([
      '-axww',
      '-o',
      'pid=,ppid=,pgid=,lstart=,comm='
    ])
    expect(runProcessMock.mock.calls[1][0].args).toEqual([
      '-ww',
      '-p',
      '30',
      '-o',
      'pid=,ppid=,pgid=,lstart=,command='
    ])
    expect(runProcessMock.mock.calls[1][0].timeoutMs).toBe(800)
    expect(capture.rows[2].command).toContain('--managed-daemon')
    expect(capture.rows[3].command).toBeUndefined()
  })

  it('does not run an argv query when there are no candidate services', async () => {
    respond(`10 1 10 ${start} /bin/zsh`)
    await readFreshProcessTable()
    expect(runProcessMock).toHaveBeenCalledOnce()
  })

  it('does not start another subprocess when the scan consumed the deadline', async () => {
    respond(`30 20 30 ${start} codex`, 1000)
    await expect(readFreshProcessTable(1000)).rejects.toThrow('deadline')
    expect(runProcessMock).toHaveBeenCalledOnce()
  })

  it.each([
    '',
    `30 20 30 Tue Jul 14 12:00:00 2026 codex app-server --managed-daemon`,
    `30 1 30 ${start} codex app-server --managed-daemon`,
    `30 20 40 ${start} codex app-server --managed-daemon`,
    `30 20 30 ${start} codex app-server --managed-daemon\n30 20 30 ${start} codex`
  ])('rejects a vanished, changed, or ambiguous candidate', async (output) => {
    respond(`30 20 30 ${start} codex`)
    respond(output)
    await expect(readFreshProcessTable()).rejects.toThrow()
  })

  it('propagates command-query failure instead of treating a daemon as terminal-owned', async () => {
    respond(`30 20 30 ${start} codex`)
    runProcessMock.mockRejectedValueOnce(new Error('timeout'))
    await expect(readFreshProcessTable()).rejects.toThrow('timeout')
  })

  it('checks only target identities for delayed escalation without reading argv', async () => {
    respond(`20 1 20 ${start}`)
    const result = await readProcessIdentities([20, 40], 123)
    expect(runProcessMock.mock.calls[0][0].args).toEqual([
      '-p',
      '20,40',
      '-o',
      'pid=,ppid=,pgid=,lstart='
    ])
    expect(runProcessMock.mock.calls[0][0].timeoutMs).toBe(123)
    expect(result.rows.map(({ pid }) => pid)).toEqual([20])
  })
})
