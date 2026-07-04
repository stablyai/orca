import { describe, expect, it } from 'vitest'
import {
  classifyAgentFromProcTable,
  parseProcTable,
  parseTmuxPaneLine,
  type ProcEntry
} from './host-sessions-handler'

const TAB = '\t'

describe('parseTmuxPaneLine', () => {
  it('parses an attached pane', () => {
    expect(
      parseTmuxPaneLine(['api', '/home/ubuntu/code/api', 'node', '1', '4242'].join(TAB))
    ).toEqual({
      session: 'api',
      cwd: '/home/ubuntu/code/api',
      command: 'node',
      attached: true,
      pid: 4242
    })
  })

  it('treats a zero client count as detached', () => {
    expect(
      parseTmuxPaneLine(['web', '/home/ubuntu/web', 'zsh', '0', '77'].join(TAB))?.attached
    ).toBe(false)
  })

  it('treats a client count above one as attached', () => {
    expect(
      parseTmuxPaneLine(['web', '/home/ubuntu/web', 'zsh', '2', '77'].join(TAB))?.attached
    ).toBe(true)
  })

  it('returns undefined pid when pane_pid is non-numeric', () => {
    expect(parseTmuxPaneLine(['s', '/tmp', 'sh', '1', ''].join(TAB))?.pid).toBeUndefined()
  })

  it('returns null when required fields are missing', () => {
    expect(parseTmuxPaneLine('')).toBeNull()
    expect(parseTmuxPaneLine(['only-session'].join(TAB))).toBeNull()
    expect(parseTmuxPaneLine(['', '/tmp', 'sh', '1', '5'].join(TAB))).toBeNull()
  })

  it('keeps commands that contain spaces intact', () => {
    expect(
      parseTmuxPaneLine(['s', '/tmp', 'node dist/server.js', '1', '9'].join(TAB))?.command
    ).toBe('node dist/server.js')
  })
})

describe('parseProcTable', () => {
  it('parses pid/ppid/comm rows and preserves comms with spaces', () => {
    const table = parseProcTable(['  100   1 zsh', ' 101 100 node dist/x.js', 'garbage'].join('\n'))
    expect(table.get(100)).toEqual({ ppid: 1, comm: 'zsh' })
    expect(table.get(101)).toEqual({ ppid: 100, comm: 'node dist/x.js' })
    expect(table.size).toBe(2)
  })

  it('returns an empty map for empty input', () => {
    expect(parseProcTable('').size).toBe(0)
  })
})

describe('classifyAgentFromProcTable', () => {
  const table = (rows: [number, number, string][]): Map<number, ProcEntry> =>
    new Map(rows.map(([pid, ppid, comm]) => [pid, { ppid, comm }]))

  it('detects claude nested below the pane shell', () => {
    // pane_pid 100 (zsh) → 200 (node) → 300 (claude)
    const procs = table([
      [100, 1, 'zsh'],
      [200, 100, 'node'],
      [300, 200, 'claude']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBe('claude')
  })

  it('detects codex as a direct child', () => {
    const procs = table([
      [100, 1, 'zsh'],
      [200, 100, 'codex']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBe('codex')
  })

  it('does not match unrelated commands like claude-code-lookalike suffixes', () => {
    const procs = table([
      [100, 1, 'zsh'],
      [200, 100, 'claudette']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBeNull()
  })

  it('returns null when the subtree has no agent', () => {
    const procs = table([
      [100, 1, 'zsh'],
      [200, 100, 'vim']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBeNull()
  })

  it('does not match agents outside the pane subtree', () => {
    // claude (300) lives under a different root (999), not under pane_pid 100.
    const procs = table([
      [100, 1, 'zsh'],
      [999, 1, 'bash'],
      [300, 999, 'claude']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBeNull()
  })

  it('returns null when rootPid is undefined', () => {
    expect(classifyAgentFromProcTable(undefined, table([[1, 0, 'claude']]))).toBeNull()
  })

  it('terminates on cyclic ppid references', () => {
    // Defensive: a malformed table where 100↔200 point at each other must not hang.
    const procs = table([
      [100, 200, 'zsh'],
      [200, 100, 'vim']
    ])
    expect(classifyAgentFromProcTable(100, procs)).toBeNull()
  })
})
