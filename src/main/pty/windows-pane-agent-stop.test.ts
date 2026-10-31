import { describe, expect, it, vi } from 'vitest'
import {
  captureWindowsPaneAgentStop,
  stopWindowsPaneAgentAndWait,
  windowsPaneAgentStopAvailable,
  windowsPaneAgentStopReleased,
  type WindowsPaneAgentStopDeps
} from './windows-pane-agent-stop'
import type { WindowsProcessRow } from '../windows/windows-process-table'

function rig(shellName = 'pwsh.exe') {
  let rows: WindowsProcessRow[] = [
    { pid: 10, ppid: 1, name: 'pty-gate.exe', command: '', creationTimeMs: 100 },
    { pid: 11, ppid: 10, name: shellName, command: shellName, creationTimeMs: 110 },
    { pid: 20, ppid: 11, name: 'claude.exe', command: 'claude.exe', creationTimeMs: 200 },
    { pid: 21, ppid: 20, name: 'node.exe', command: 'node server.js', creationTimeMs: 210 },
    { pid: 30, ppid: 11, name: 'node.exe', command: 'node dev.js', creationTimeMs: 300 }
  ]
  const killed: number[] = []
  const deps: WindowsPaneAgentStopDeps = {
    readRows: vi.fn(async () => rows.map((row) => ({ ...row }))),
    readCreationTime: vi.fn((pid) => rows.find((row) => row.pid === pid)?.creationTimeMs ?? null),
    readConsole: vi.fn(async () => new Set([11, 20, 21, 30])),
    kill: vi.fn((pid) => {
      killed.push(pid)
      rows = rows.filter((row) => row.pid !== pid)
    })
  }
  return {
    deps,
    killed,
    rows: () => rows,
    change: (update: (previous: WindowsProcessRow[]) => WindowsProcessRow[]) => {
      rows = update(rows)
    },
    capture: () =>
      captureWindowsPaneAgentStop(
        {
          rootPid: 10,
          agent: 'claude',
          ptyId: 'pane',
          incarnationId: 'incarnation'
        },
        deps
      )
  }
}

describe('Windows pane agent stop', () => {
  it.each(['pwsh.exe', 'bash.exe'])(
    'stops only the exact agent tree below %s; background job and shell survive',
    async (shell) => {
      const r = rig(shell)
      const capture = await r.capture()
      expect(capture?.agent?.pid).toBe(20)
      expect(capture && (await windowsPaneAgentStopReleased(capture, true))).toBe(true)
      expect(capture && (await windowsPaneAgentStopReleased(capture))).toBe(false)
      expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('exited')
      expect(r.killed).toEqual([21, 20])
      expect(r.rows().map((row) => row.pid)).toEqual([10, 11, 30])
    }
  )

  it('refuses a second recognized agent before any termination', async () => {
    const r = rig()
    r.change((rows) => [
      ...rows,
      { pid: 40, ppid: 11, name: 'codex.exe', command: 'codex.exe', creationTimeMs: 400 }
    ])
    const capture = await r.capture()
    expect(capture?.refusal).toBe('agentAmbiguous')
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('unproven')
    expect(r.killed).toEqual([])
  })

  it('detects a new recognized sibling after capture before stopping', async () => {
    const r = rig()
    const capture = await r.capture()
    r.change((rows) => [
      ...rows,
      { pid: 40, ppid: 11, name: 'codex.exe', command: 'codex.exe', creationTimeMs: 400 }
    ])
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('unproven')
    expect(r.killed).toEqual([])
  })

  it('admits an already-exited agent beside an unrelated job', async () => {
    const r = rig()
    r.change((rows) => rows.filter((row) => row.pid !== 20 && row.pid !== 21))
    const capture = await r.capture()
    expect(capture?.agent).toBeNull()
    expect(capture && (await windowsPaneAgentStopReleased(capture))).toBe(true)
    expect(r.killed).toEqual([])
  })

  it('never kills a PID reused between capture and the immediate birth check', async () => {
    const r = rig()
    const capture = await r.capture()
    r.deps.readCreationTime = (pid) => {
      if (pid === 21) {
        r.change((rows) =>
          rows.map((row) => (row.pid === 21 ? { ...row, ppid: 1, creationTimeMs: 999 } : row))
        )
      }
      return r.rows().find((row) => row.pid === pid)?.creationTimeMs ?? null
    }
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('exited')
    expect(r.killed).toEqual([20])
    expect(r.rows().find((row) => row.pid === 21)?.creationTimeMs).toBe(999)
  })

  it('captures a new descendant before terminating its ancestors', async () => {
    const r = rig()
    const capture = await r.capture()
    r.change((rows) => [
      ...rows,
      { pid: 22, ppid: 21, name: 'node.exe', command: 'node worker.js', creationTimeMs: 220 }
    ])
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('exited')
    expect(r.killed).toEqual([22, 21, 20])
  })

  it('does not report success if a post-stop scan becomes unreadable', async () => {
    const r = rig()
    const capture = await r.capture()
    const kill = r.deps.kill
    r.deps.kill = (pid) => {
      kill(pid)
      if (pid === 20) {
        r.deps.readRows = async () => {
          throw new Error('proof lost')
        }
      }
    }
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('unproven')
    expect(r.killed).toEqual([21, 20])
  })

  it('refuses missing identities, recycled parent links and unknown console membership', async () => {
    for (const kind of ['missing', 'recycled', 'console']) {
      const r = rig()
      if (kind === 'missing') {
        r.change((rows) =>
          rows.map((row) => (row.pid === 20 ? { ...row, creationTimeMs: undefined } : row))
        )
      }
      if (kind === 'recycled') {
        r.change((rows) =>
          rows.map((row) => (row.pid === 11 ? { ...row, creationTimeMs: 999 } : row))
        )
      }
      if (kind === 'console') {
        r.deps.readConsole = async () => null
      }
      expect(await r.capture()).toBeNull()
      expect(r.killed).toEqual([])
    }
  })

  it('refuses changed pane ownership and unreadable proof', async () => {
    const r = rig()
    const capture = await r.capture()
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => false))).toBe('unproven')
    expect(r.killed).toEqual([])
    r.deps.readRows = async () => {
      throw new Error('unreadable')
    }
    expect(capture && (await stopWindowsPaneAgentAndWait(capture, () => true))).toBe('unproven')
  })

  it('refuses an agent replacing the PTY root shell', async () => {
    const r = rig()
    r.change((rows) =>
      rows.map((row) =>
        row.pid === 10 ? { ...row, name: 'claude.exe', command: 'claude.exe' } : row
      )
    )
    expect((await r.capture())?.refusal).toBe('shellReplaced')
    expect(r.killed).toEqual([])
  })

  it('does not advertise Windows stopping on other platforms', () => {
    if (process.platform !== 'win32') {
      expect(windowsPaneAgentStopAvailable()).toBe(false)
    }
  })
})
