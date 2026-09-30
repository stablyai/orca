import { describe, expect, it } from 'vitest'
import {
  CodexClientProcessSnapshot,
  isCodexClientProcess,
  listCodexDaemonHookPanes
} from './codex-client-panes'
import type { ProcessIdentityRow } from '../opencode/opencode-client-sweep'

function row(pid: number, ppid: number, executable: string, argv: string[]): ProcessIdentityRow {
  return { pid, ppid, startedAtMs: 0, executable, argv }
}

describe('isCodexClientProcess', () => {
  it('recognizes the native binary, its npm launcher, and truncated triple names', () => {
    expect(isCodexClientProcess(row(1, 0, '/opt/homebrew/bin/codex', ['codex']))).toBe(true)
    expect(isCodexClientProcess(row(1, 0, 'node', ['node', '/x/bin/codex.js']))).toBe(true)
    expect(isCodexClientProcess(row(1, 0, 'codex-x86_64-un', ['codex-x86_64-unknown']))).toBe(true)
    expect(isCodexClientProcess(row(1, 0, 'codex.exe', ['C:\\bin\\codex.exe']))).toBe(true)
  })

  it('rejects the shared app-server daemon and unrelated processes', () => {
    const daemon = row(1, 0, 'codex', ['codex', 'app-server', '--managed-daemon'])
    expect(isCodexClientProcess(daemon)).toBe(false)
    expect(isCodexClientProcess(row(1, 0, 'zsh', ['-zsh']))).toBe(false)
    expect(isCodexClientProcess(row(1, 0, 'node', ['node', 'codexify.js']))).toBe(false)
  })
})

describe('listCodexDaemonHookPanes', () => {
  const ptys = [
    { ptyId: 'a', worktreeId: 'repo::/a', sessionId: null, paneKey: 'tab-a:1', pid: 100 },
    { ptyId: 'b', worktreeId: 'repo::/a', sessionId: null, paneKey: 'tab-a:2', pid: 200 },
    { ptyId: 'c', worktreeId: 'repo::/b', sessionId: null, paneKey: null, pid: 300 }
  ]

  it('flags only panes with a Codex client somewhere beneath their shell', () => {
    const processes = [
      row(101, 100, 'node', ['node', '/x/bin/codex.js']),
      row(102, 101, 'codex', ['codex']),
      row(201, 200, 'node', ['node', 'vite']),
      row(301, 300, 'codex', ['codex'])
    ]
    expect(listCodexDaemonHookPanes(ptys, processes)).toEqual([
      { paneKey: 'tab-a:1', worktreeId: 'repo::/a', runsCodexClient: true },
      { paneKey: 'tab-a:2', worktreeId: 'repo::/a', runsCodexClient: false },
      { paneKey: null, worktreeId: 'repo::/b', runsCodexClient: false }
    ])
  })

  it('flags nothing when the sweep was unavailable', () => {
    expect(listCodexDaemonHookPanes(ptys, null).some((pane) => pane.runsCodexClient)).toBe(false)
  })
})

describe('CodexClientProcessSnapshot', () => {
  it('shares one sweep across posts within a second, then sweeps again', async () => {
    let nowMs = 0
    let sweeps = 0
    const snapshot = new CodexClientProcessSnapshot(
      async () => {
        sweeps += 1
        return []
      },
      () => nowMs
    )
    await Promise.all([snapshot.read(), snapshot.read()])
    nowMs = 500
    await snapshot.read()
    expect(sweeps).toBe(1)
    nowMs = 1_500
    await snapshot.read()
    expect(sweeps).toBe(2)
  })

  it('resolves null instead of throwing when the sweep fails', async () => {
    const snapshot = new CodexClientProcessSnapshot(async () => {
      throw new Error('ps failed')
    })
    await expect(snapshot.read()).resolves.toBeNull()
  })
})
