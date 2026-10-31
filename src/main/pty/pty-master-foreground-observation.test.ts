import type * as ForegroundModule from './terminal-process-rows'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  observePtyForeground,
  readPtyForegroundGroup,
  resolvePtyForegroundMembers
} from './pty-master-foreground-observation'
import { isTerminalForegroundObservation } from '../../shared/terminal-foreground-observation'
import { judgeTerminalForeground } from '../runtime/terminal-foreground-group'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { TuiAgent } from '../../shared/tui-agent'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), tty: vi.fn(), ps: vi.fn() }))
vi.mock('./terminal-process-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof ForegroundModule>()),
  readPtyTerminalRows: mocks.rows,
  readTerminalTty: mocks.tty,
  readTerminalPs: mocks.ps
}))
const row = (command: string, pid = 201, pgid = 200) => ({
  pid,
  ppid: 100,
  pgid,
  tpgid: 200,
  stat: 'S+',
  command
})
const proc = () => ({
  pid: 100,
  fd: 9,
  ptsName: '/dev/pts/5',
  getForegroundProcessGroup: vi.fn((): number | null | undefined => 200)
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows.mockResolvedValue([row('claude')])
  mocks.tty.mockResolvedValue('pts/5')
  mocks.ps.mockResolvedValue('200 pts/5')
})
describe('physical PTY observations', () => {
  it('survives client rebind and a missing group leader/root row', async () => {
    const owner = proc()
    const first = await observePtyForeground(owner, () => true)
    const afterRebind = await observePtyForeground(owner, () => true)
    expect(first).toMatchObject({
      verdict: 'observed',
      source: 'pty-master',
      foregroundKind: 'non-shell',
      processName: 'claude',
      foregroundPgid: 200
    })
    expect(afterRebind).toEqual(first)
    expect(mocks.tty).not.toHaveBeenCalled()
  })
  it('uses all members rather than naming only a wrapper leader', async () => {
    mocks.rows.mockResolvedValue([
      row('sh ./wrapper', 200),
      { ...row('node /opt/node_modules/@openai/codex/bin/codex.js'), ppid: 200 }
    ])
    expect(await observePtyForeground(proc(), () => true)).toMatchObject({
      verdict: 'observed',
      foregroundKind: 'non-shell',
      processName: 'codex'
    })
  })
  it.each([
    ['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume abc', 'claude'],
    ['/home/user/.local/share/claude/versions/2.1.26', '2.1.26'],
    ['python3 /opt/work/unknown_agent.py', 'python3']
  ])(
    'resolves real installation argv without rewriting the user command: %s',
    (command, processName) => {
      const sample = resolvePtyForegroundMembers([row(command)], 200)
      expect(sample).toMatchObject({
        verdict: 'observed',
        foregroundKind: 'non-shell',
        processName
      })
    }
  )
  it('keeps unreadable non-shell identity separate from local non-shell admission', () => {
    expect(resolvePtyForegroundMembers([row('(node)')], 200)).toMatchObject({
      verdict: 'observed',
      foregroundKind: 'non-shell',
      processName: null
    })
  })

  it('never queries a retired/reused fd or rescues a supported failure with a cached name', async () => {
    const owner = proc()
    owner.fd = -1
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
    expect(owner.getForegroundProcessGroup).not.toHaveBeenCalled()
    owner.fd = 9
    owner.getForegroundProcessGroup.mockReturnValue(null)
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'master_unavailable'
    })
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('discards late results from a replaced session', async () => {
    let current = true
    mocks.rows.mockImplementation(async () => {
      current = false
      return [row('claude')]
    })
    expect(await observePtyForeground(proc(), () => current)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'session_changed'
    })
  })
  it('rereads at most once when the group changes and obeys its original deadline', async () => {
    const owner = proc()
    owner.getForegroundProcessGroup
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.rows).toHaveBeenCalledTimes(2)
    mocks.rows.mockClear()
    expect(await observePtyForeground(proc(), () => true, 0)).toMatchObject({
      verdict: 'unverifiable'
    })
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('supports older native images with fresh PTY-matched root proof', async () => {
    const owner = proc()
    owner.getForegroundProcessGroup.mockReturnValue(undefined)
    mocks.rows.mockResolvedValue([row('zsh', 100, 100), row('claude')])
    expect(readPtyForegroundGroup(owner)).toBeUndefined()
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'observed',
      source: 'posix-process-table'
    })
    mocks.tty.mockResolvedValue('pts/6')
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
  })
  it('validates optional host observations without treating a future/malformed branch as proof', () => {
    const metadata = {
      ptyId: 'p',
      ptyIncarnationId: 'i',
      authorityGeneration: 'a',
      observationEpoch: 1,
      capturedAgeMs: 0
    }
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude',
        foregroundPgid: 200
      })
    ).toBe(true)
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'agent',
        processName: 'claude'
      })
    ).toBe(false)
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'unverifiable',
        reason: 'new_host_reason'
      })
    ).toBe(true)
  })
})

/** `ps -t` rows on one terminal: the shell (root 100) and whatever holds foreground group `tpgid`. */
function terminal(
  tpgid: number,
  members: [pid: number, ppid: number, pgid: number, stat: string, command: string][]
): ProcessTableRow[] {
  return members.map(([pid, ppid, pgid, stat, command]) => ({
    pid,
    ppid,
    pgid,
    tpgid,
    stat,
    command
  }))
}
const CLAUDE_NODE = 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
const CODEX_NODE = 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js'
const CODEX_NATIVE =
  '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'

describe('local admission parity with the root-pid judge', () => {
  it.each<[string, TuiAgent, ProcessTableRow[]]>([
    ['plain shell', 'claude', terminal(100, [[100, 1, 100, 'Ss+', '-zsh']])],
    [
      'nested shell',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', 'bash']
      ])
    ],
    [
      'native claude',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', 'claude --resume abc']
      ])
    ],
    [
      'node claude',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', CLAUDE_NODE]
      ])
    ],
    [
      'codex node with its native child',
      'codex',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', CODEX_NODE],
        [201, 200, 200, 'S+', CODEX_NATIVE]
      ])
    ],
    [
      'non-exec wrapper script',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', 'sh /usr/local/bin/claude'],
        [201, 200, 200, 'S+', CLAUDE_NODE]
      ])
    ],
    [
      'interpreter running an agent script',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', 'bash /opt/bin/claude']
      ])
    ],
    [
      'agent stopped with Ctrl-Z',
      'claude',
      terminal(100, [
        [100, 1, 100, 'Ss+', '-zsh'],
        [200, 100, 200, 'T', 'claude']
      ])
    ],
    [
      'tmux client',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', 'tmux attach']
      ])
    ],
    [
      'sudo with withheld argv',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', '(sudo)']
      ])
    ],
    [
      'unreadable root shell',
      'claude',
      terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, 'S+', '(bash)']
      ])
    ]
  ])('%s', (_name, agent, rows) => {
    const sample = resolvePtyForegroundMembers(rows, rows[0].tpgid ?? 0)
    const local =
      sample.verdict !== 'observed'
        ? 'unknown'
        : sample.foregroundKind === 'shell'
          ? 'shell'
          : 'agent'
    expect(local).toBe(judgeTerminalForeground(rows, 100, agent))
  })

  it('refuses a zombie or stopped-only foreground the root-pid judge admitted', () => {
    for (const stat of ['Z+', 'T+']) {
      const rows = terminal(200, [
        [100, 1, 100, 'Ss', '-zsh'],
        [200, 100, 200, stat, 'claude']
      ])
      expect(judgeTerminalForeground(rows, 100, 'claude')).toBe('agent')
      expect(resolvePtyForegroundMembers(rows, 200).verdict).toBe('unverifiable')
    }
  })
})
