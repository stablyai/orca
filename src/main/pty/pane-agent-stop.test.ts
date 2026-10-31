import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { stopPaneAgentAndWait, type PaneAgentStopCapture } from './pane-agent-stop'

const shell: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 200,
  tty: 'ttys020',
  startTime: 'shell-start',
  stat: 'Ss',
  command: '/bin/zsh'
}
const agent: ProcessTableRow = {
  pid: 200,
  ppid: 100,
  pgid: 200,
  tpgid: 200,
  tty: 'ttys020',
  startTime: 'agent-start',
  stat: 'T',
  command: 'claude'
}
const child: ProcessTableRow = {
  pid: 201,
  ppid: 200,
  pgid: 201,
  tpgid: -1,
  tty: '?',
  startTime: 'child-start',
  stat: 'S',
  command: 'sleep 60'
}
const capture: PaneAgentStopCapture = {
  shell: { pid: 100, startTime: 'shell-start' },
  agent: { pid: 200, startTime: 'agent-start' },
  agentType: 'claude',
  tty: '/dev/ttys020',
  agentPgid: 200,
  paused: true
}

afterEach(() => vi.useRealTimers())

describe('stopPaneAgentAndWait', () => {
  it('stops a paused agent and retained reparented child, then proves the same shell survives', async () => {
    vi.useFakeTimers()
    let rows = [{ ...shell, tpgid: 100 }, agent, child]
    const signals: [number, string][] = []
    const result = stopPaneAgentAndWait(capture, {
      readRows: async () => rows,
      ownsPane: () => true,
      graceMs: 100,
      signal: (identity, signal) => {
        signals.push([identity.pid, signal])
        if (identity.pid === 200 && signal === 'SIGCONT') {
          rows = rows
            .filter((row) => row.pid !== 200)
            .map((row) => (row.pid === 201 ? { ...row, ppid: 1 } : row))
        }
        if (identity.pid === 201 && signal === 'SIGKILL') {
          rows = rows.filter((row) => row.pid !== 201)
        }
      }
    })
    await vi.runAllTimersAsync()
    expect(await result).toBe('exited')
    expect(signals).toEqual([
      [201, 'SIGTERM'],
      [200, 'SIGTERM'],
      [200, 'SIGCONT'],
      [201, 'SIGKILL']
    ])
    expect(rows).toEqual([{ ...shell, tpgid: 100 }])
  })

  it('never signals a reused identity or proves exit from unreadable or changed-pane evidence', async () => {
    vi.useFakeTimers()
    const signal = vi.fn()
    const deps = {
      readRows: async () => [shell, { ...agent, startTime: 'replacement' }],
      ownsPane: () => true,
      signal
    }
    expect(await stopPaneAgentAndWait(capture, deps)).toBe('unproven')
    expect(signal).not.toHaveBeenCalled()
    let reads = 0
    const result = stopPaneAgentAndWait(capture, {
      ...deps,
      readRows: async () => {
        reads += 1
        if (reads > 1) {
          throw new Error('process table unavailable')
        }
        return [shell, agent]
      }
    })
    expect(await result).toBe('unproven')
    expect(signal).not.toHaveBeenCalled()
    expect(await stopPaneAgentAndWait(capture, { ...deps, ownsPane: () => false })).toBe('unproven')
    expect(signal).not.toHaveBeenCalled()
    let rows = [shell, { ...agent, stat: 'S' }]
    const reusedSignals: string[] = []
    const replacement = stopPaneAgentAndWait(capture, {
      ...deps,
      verifyMs: 200,
      graceMs: 50,
      readRows: async () => rows,
      signal: (_, sent) => {
        reusedSignals.push(sent)
        rows = [
          { ...shell, tpgid: 100 },
          { ...agent, startTime: 'replacement', stat: 'S' }
        ]
      }
    })
    await vi.runAllTimersAsync()
    expect(await replacement).toBe('unproven')
    expect(reusedSignals).toEqual(['SIGTERM'])
  })
})

it('stops an entire pure wrapper chain, retaining children captured before Escape', async () => {
  vi.useFakeTimers()
  const wrapper = {
    ...agent,
    pid: 150,
    ppid: shell.pid,
    startTime: 'wrapper',
    stat: 'S',
    command: 'npx'
  }
  const inner = { ...wrapper, pid: 160, ppid: 150, startTime: 'inner', command: 'node wrapper.js' }
  let rows: ProcessTableRow[] = [
    { ...shell, tpgid: shell.pgid },
    wrapper,
    inner,
    { ...agent, ppid: 160, stat: 'S' }
  ]
  const signals: number[] = []
  const wrapped = { ...capture, stopRoot: { pid: 150, startTime: 'wrapper' } }
  const result = stopPaneAgentAndWait(wrapped, {
    readRows: async () => rows,
    ownsPane: () => true,
    signal: (target) => {
      signals.push(target.pid)
      rows = rows.filter((row) => row.pid !== target.pid)
    }
  })
  await vi.runAllTimersAsync()
  expect(await result).toBe('exited')
  expect(signals).toEqual([200, 160, 150])
  rows = [
    { ...shell, tpgid: shell.pgid },
    { ...child, ppid: 1 }
  ]
  const retained = stopPaneAgentAndWait(
    { ...capture, targets: [capture.agent, { pid: child.pid, startTime: child.startTime! }] },
    {
      readRows: async () => rows,
      ownsPane: () => true,
      signal: (target) => {
        rows = rows.filter((row) => row.pid !== target.pid)
      }
    }
  )
  await vi.runAllTimersAsync()
  expect(await retained).toBe('exited')
  expect(rows).toEqual([{ ...shell, tpgid: shell.pgid }])
})
