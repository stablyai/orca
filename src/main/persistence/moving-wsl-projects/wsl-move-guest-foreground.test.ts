import { describe, expect, it } from 'vitest'
import {
  classifyWslGuestPaneForeground,
  readWslGuestPaneShellCwd,
  type WslGuestProcessRow
} from './wsl-move-guest-foreground'
const KEY_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const KEY_B = 'tab-2:22222222-1111-4111-8111-111111111111'

const RELAY = 10
// The WSL relay (`init`) starts the pane's login shell as a session leader.
const relay: WslGuestProcessRow = {
  pid: RELAY,
  ppid: 1,
  sid: 1,
  argc: 1,
  comm: 'init',
  paneKey: null
}
const shellA: WslGuestProcessRow = {
  pid: 100,
  ppid: RELAY,
  sid: 100,
  argc: 1,
  comm: 'bash',
  paneKey: KEY_A
}
const child = (
  pid: number,
  comm: string,
  extra: Partial<WslGuestProcessRow> = {}
): WslGuestProcessRow => ({ pid, ppid: 100, sid: 100, argc: 1, comm, paneKey: KEY_A, ...extra })

describe('classifyWslGuestPaneForeground', () => {
  // Every one of these survived the old foreground-group check and would end at the move's Sleep.
  it.each([
    ['a foreground program', [child(150, 'vim')]],
    ['a background job', [child(150, 'npm')]],
    ['a nohup or disowned job reparented to init', [child(150, 'node', { ppid: 1 })]],
    ['a setsid daemon that kept the key', [child(150, 'redis-server', { ppid: 1, sid: 150 })]],
    ['a child that cleared its environment', [child(150, 'python3', { paneKey: null })]],
    ['a script waiting at `read`', [child(150, 'bash', { argc: 2 })]],
    ['`sh -c` running a command', [child(150, 'sh', { argc: 3 })]]
  ])('blocks %s', (_label, extra) => {
    expect(classifyWslGuestPaneForeground([relay, shellA, ...extra], KEY_A)).toBe('process-running')
  })

  it("ignores another pane's work and the relay above the shell", () => {
    const shellB = { ...shellA, pid: 200, sid: 200, paneKey: KEY_B }
    const rows = [relay, shellA, shellB, child(250, 'vim', { ppid: 200, sid: 200, paneKey: KEY_B })]
    expect(classifyWslGuestPaneForeground(rows, KEY_A)).toBe('shell-idle')
    expect(classifyWslGuestPaneForeground(rows, KEY_B)).toBe('process-running')
  })

  it('still blocks an agent with a job of the shell beside it', () => {
    const codex = child(150, 'codex')
    expect(classifyWslGuestPaneForeground([relay, shellA, codex, child(170, 'sleep')], KEY_A)).toBe(
      'process-running'
    )
    expect(
      classifyWslGuestPaneForeground(
        [relay, shellA, codex, child(170, 'node', { ppid: 1, sid: 170 })],
        KEY_A
      )
    ).toBe('process-running')
  })

  it('never reads a pane whose shell was not found as idle', () => {
    expect(classifyWslGuestPaneForeground([relay], KEY_A)).toBe('unverifiable')
  })
})

describe('readWslGuestPaneShellCwd', () => {
  it("reads the pane's shell folder, not its relay's or a child's", () => {
    const rows = [
      { ...relay, paneKey: KEY_A, cwd: '/' },
      { ...shellA, cwd: '/home/dev/app/deep/er' },
      child(150, 'vim', { cwd: '/tmp' })
    ]
    expect(readWslGuestPaneShellCwd(rows, KEY_A)).toBe('/home/dev/app/deep/er')
  })

  it('reads nothing when the shell is missing, ambiguous, or its folder unreadable', () => {
    expect(readWslGuestPaneShellCwd([relay], KEY_A)).toBeNull()
    expect(readWslGuestPaneShellCwd([relay, shellA], KEY_A)).toBeNull()
    const twin = { ...shellA, pid: 300, ppid: 1, sid: 300, cwd: '/b' }
    expect(readWslGuestPaneShellCwd([relay, { ...shellA, cwd: '/a' }, twin], KEY_A)).toBeNull()
  })
})
