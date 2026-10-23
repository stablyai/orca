import { execFileSync } from 'node:child_process'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { describe, expect, it, vi } from 'vitest'
import { collectWslMoveGateInputs, type WslMoveGateFactSources } from './wsl-move-gate-facts'
import {
  classifyWslGuestPaneForeground,
  parseWslGuestPaneProcesses,
  readWslGuestPaneShellCwd,
  WSL_GUEST_PANE_PROCESS_SCRIPT,
  type WslGuestProcessRow
} from './wsl-move-guest-foreground'
import { assessWslMoveTerminals } from './wsl-move-terminal-gate'

const WT = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const KEY_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const KEY_B = 'tab-2:22222222-1111-4111-8111-111111111111'
const scope = { workspaceIds: [WT], workspaceKeys: new Set([WT]) }

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
  it('reads a pane whose shell has nothing else, or only an idle nested shell, as idle', () => {
    expect(classifyWslGuestPaneForeground([relay, shellA], KEY_A)).toBe('shell-idle')
    expect(classifyWslGuestPaneForeground([relay, shellA, child(110, 'zsh')], KEY_A)).toBe(
      'shell-idle'
    )
  })

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

  it('finds the shell under a WSL relay that carries the pane key too', () => {
    // awin: a live pane read unverifiable because its relay held the key above the shell.
    const taggedRelay = { ...relay, paneKey: KEY_A }
    expect(classifyWslGuestPaneForeground([taggedRelay, shellA], KEY_A)).toBe('shell-idle')
    expect(classifyWslGuestPaneForeground([taggedRelay, shellA, child(150, 'vim')], KEY_A)).toBe(
      'process-running'
    )
  })

  it("names an agent that is the shell's one job, with its own children, as the foreground", () => {
    // awin verify-4: an idle codex at its prompt read as a running program.
    const codex = child(150, 'codex', { argc: 3 })
    const hook = child(160, 'sh', { ppid: 150, argc: 2 })
    expect(classifyWslGuestPaneForeground([relay, shellA, codex, hook], KEY_A)).toEqual({
      agent: 'codex'
    })
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

describe('parseWslGuestPaneProcesses', () => {
  it('reads the folder last, keeping a tab in it and dropping a removed one', () => {
    expect(
      parseWslGuestPaneProcesses(
        `10\t1\t10\t1\tbash\t${KEY_A}\t/home/a\tb\n11\t1\t11\t1\tbash\t\t/gone (deleted)\n`
      )
    ).toEqual([
      { pid: 10, ppid: 1, sid: 10, argc: 1, comm: 'bash', paneKey: KEY_A, cwd: '/home/a\tb' },
      { pid: 11, ppid: 1, sid: 11, argc: 1, comm: 'bash', paneKey: null }
    ])
  })

  it('keeps comm with spaces and drops malformed lines', () => {
    expect(
      parseWslGuestPaneProcesses(
        `10\t1\t10\t1\tmy prog\t${KEY_A}\nbad line\n11\t10\t10\t     2\tbash\t\n`
      )
    ).toEqual([
      { pid: 10, ppid: 1, sid: 10, argc: 1, comm: 'my prog', paneKey: KEY_A },
      { pid: 11, ppid: 10, sid: 10, argc: 2, comm: 'bash', paneKey: null }
    ])
  })
})

describe.runIf(process.platform === 'linux')('WSL_GUEST_PANE_PROCESS_SCRIPT on Linux', () => {
  it('lists processes as pid, ppid, sid, argc, comm and pane key', () => {
    const out = execFileSync('sh', ['-c', WSL_GUEST_PANE_PROCESS_SCRIPT], { encoding: 'utf8' })
    const rows = parseWslGuestPaneProcesses(out)
    for (const row of rows) {
      expect(row.pid).toBeGreaterThan(0)
    }
    expect(rows.some((row) => row.cwd?.startsWith('/'))).toBe(true)
  })
})

describe('collectWslMoveGateInputs with a guest foreground reader', () => {
  // The Windows host sees `wsl.exe` under every live bridge pane: this is what it reported on awin.
  const windowsSaysLive: WslMoveGateFactSources['inspect'] = async () => ({
    foregroundProcess: 'wsl.exe',
    hasChildProcesses: true,
    childProcessEvidence: 'children'
  })
  const base: WslMoveGateFactSources = {
    listTerminals: () => [
      {
        ptyId: 'pty-1',
        workspaceId: WT,
        paneKey: KEY_A,
        wslDistro: 'Ubuntu',
        foregroundAgent: null
      }
    ],
    inspect: windowsSaysLive,
    agentRows: () => [],
    scrollbackBytes: async () => 10,
    automationRuns: () => [],
    dispatches: () => []
  }

  it('passes an idle bridge shell the Windows host reads as running wsl.exe', async () => {
    const inputs = await collectWslMoveGateInputs(
      { ...base, guestForegrounds: async () => new Map([[KEY_A, 'shell-idle']]) },
      scope
    )
    expect(inputs.panes[0]?.foreground).toBe('shell-idle')
    expect(assessWslMoveTerminals(inputs).verdict).toBe('ready')
  })

  it('still blocks a real guest program, and a guest that cannot be read', async () => {
    const busy = await collectWslMoveGateInputs(
      { ...base, guestForegrounds: async () => new Map([[KEY_A, 'process-running']]) },
      scope
    )
    expect(assessWslMoveTerminals(busy).verdict).toBe('blocked')
    const failed = await collectWslMoveGateInputs(
      {
        ...base,
        guestForegrounds: async () => {
          throw new Error('wsl_unavailable')
        }
      },
      scope
    )
    expect(failed.panes[0]?.foreground).toBe('unverifiable')
  })

  it('lets the hook status decide for an agent at its prompt, and keeps a working one blocking', async () => {
    const rows = (state: AgentStatusIpcPayload['state']) => (): AgentStatusIpcPayload[] => [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only the fields set here.
      {
        paneKey: KEY_A,
        state,
        prompt: '',
        agentType: 'codex',
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: 1,
        providerSession: { key: 'session_id', id: '0f0e0d0c-1111-4111-8111-111111111111' }
      } as AgentStatusIpcPayload
    ]
    const guestForegrounds = async () => new Map([[KEY_A, { agent: 'codex' }]])
    const idle = await collectWslMoveGateInputs(
      { ...base, agentRows: rows('done'), guestForegrounds },
      scope
    )
    expect(assessWslMoveTerminals(idle).verdict).toBe('ready')
    const working = await collectWslMoveGateInputs(
      { ...base, agentRows: rows('working'), guestForegrounds },
      scope
    )
    expect(assessWslMoveTerminals(working)).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'agent-working' }]
    })
  })

  it('leaves a slept pane idle without asking the distro, which has no shell of it left', async () => {
    // awin: every slept pane read unverifiable, so Sleep could no longer quiet a project.
    const guestForegrounds = vi.fn(async () => new Map([[KEY_A, 'unverifiable' as const]]))
    const slept = await collectWslMoveGateInputs(
      {
        ...base,
        inspect: async () => ({
          foregroundProcess: null,
          hasChildProcesses: false,
          childProcessEvidence: 'no-children'
        }),
        guestForegrounds
      },
      scope
    )
    expect(slept.panes[0]?.foreground).toBe('shell-idle')
    expect(guestForegrounds).not.toHaveBeenCalled()
  })
})
