import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCodexManagedDaemon } from './pty-codex-managed-daemon'
import {
  collectDescendantRows,
  parseProcessTable,
  terminateDescendantSnapshot
} from './pty-descendant-termination'

const startedAt = 'Mon Jul 13 12:54:47 2026'
const capturedAtMs = Date.parse('Tue Jul 14 12:00:00 2026')

function processRow(pid: number, ppid: number, pgid: number, command: string) {
  return { pid, ppid, pgid, startedAt, command }
}

afterEach(() => vi.useRealTimers())

describe('Codex managed daemon ownership', () => {
  it.each([
    'codex app-server --listen unix:// --managed-daemon',
    '/opt/codex/bin/codex app-server --managed-daemon --listen unix://',
    '/opt/codex/bin/codex app-server daemon pid-update-loop'
  ])('recognizes the shared service: %s', (command) => {
    expect(isCodexManagedDaemon(command)).toBe(true)
  })

  it.each([
    undefined,
    'codex',
    'codex exec --managed-daemon',
    'codex app-server',
    'codex app-server --listen stdio://',
    'codex app-server --listen unix://',
    'codex app-server --managed-daemon-other',
    'codex app-server daemon status',
    'codex app-server daemon pid-update-loop extra',
    'other app-server --managed-daemon',
    '/bin/sh -c codex app-server --managed-daemon',
    'echo codex app-server --managed-daemon'
  ])('keeps terminal-owned or unrelated commands eligible: %s', (command) => {
    expect(isCodexManagedDaemon(command)).toBe(false)
  })

  it('parses command text without changing the process start identity', () => {
    expect(
      parseProcessTable(
        `  30 20 30 Mon Jul  6 12:54:47 2026 /opt/bin/codex app-server --listen unix:// --managed-daemon\n`
      )
    ).toEqual([
      {
        pid: 30,
        ppid: 20,
        pgid: 30,
        startedAt: 'Mon Jul  6 12:54:47 2026',
        command: '/opt/bin/codex app-server --listen unix:// --managed-daemon'
      }
    ])
  })

  it('excludes both service subtrees from TERM and delayed KILL after reparenting', async () => {
    vi.useFakeTimers()
    const rows = [
      processRow(10, 1, 10, '/bin/zsh'),
      processRow(20, 10, 20, '/opt/bin/codex'),
      processRow(30, 20, 30, '/opt/bin/codex app-server --listen unix:// --managed-daemon'),
      processRow(31, 30, 31, 'codex-code-mode-host'),
      processRow(32, 31, 32, '/bin/zsh'),
      processRow(40, 20, 40, '/opt/bin/codex app-server daemon pid-update-loop'),
      processRow(41, 40, 40, 'sleep 10'),
      processRow(50, 20, 50, 'codex app-server'),
      processRow(51, 50, 51, 'node tool.js'),
      processRow(60, 20, 60, 'codex exec task'),
      processRow(70, 20, 20, 'codex app-server --managed-daemon')
    ]
    const snapshot = collectDescendantRows(10, rows, capturedAtMs)
    const expected = [20, 50, 60, 70, 51]
    expect(snapshot.descendants.map(({ pid }) => pid)).toEqual(expected)
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockResolvedValue({
      rows: rows.map((row) => ({ ...row, ppid: 1 })),
      capturedAtMs: capturedAtMs + 2000
    })
    terminateDescendantSnapshot(snapshot, { sendSignal, readTable })
    expect(sendSignal.mock.calls).toEqual(expected.map((pid) => [pid, 'SIGTERM']))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendSignal.mock.calls).toEqual([
      ...expected.map((pid) => [pid, 'SIGTERM']),
      ...expected.map((pid) => [pid, 'SIGKILL'])
    ])
  })
})
