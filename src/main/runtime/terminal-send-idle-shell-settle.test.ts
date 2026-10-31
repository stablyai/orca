import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/idle-shell-settle',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const PTY_ID = 'pty-idle-shell'
const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
const IDLE_PROMPT = `${A}$ ${B}ls\r\n${C}file\r\n${D0}${A}$ ${B}`

type PaneSetup = {
  output?: string
  launchAgent?: 'claude'
  foregroundAgent?: 'claude'
  /** The host's shell-foreground proof; null omits the capability. */
  shellForeground?: boolean | 'hang' | null
  hookRows?: AgentStatusIpcPayload[]
  sends?: number
}

/** Milliseconds from each send to its Enter write, after the pane painted `output`. */
async function enterDelays(setup: PaneSetup): Promise<number[]> {
  const { output, launchAgent, foregroundAgent, shellForeground = true, hookRows = [] } = setup
  vi.useFakeTimers()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the repo/worktree members this fixture provides.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshotForPane: () => hookRows
  })
  let sentAt = 0
  const delays: number[] = []
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: (_ptyId, data) => {
      if (data === '\r') {
        delays.push(Date.now() - sentAt)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    ...(shellForeground === null
      ? {}
      : {
          confirmShellForeground: () =>
            shellForeground === 'hang'
              ? new Promise<boolean>(() => {})
              : Promise.resolve(shellForeground)
        })
  })
  const { handle } = await runtime.createTerminal('path:/tmp/worktree-a')
  if (output !== undefined) {
    runtime.onPtyData(PTY_ID, output, Date.now())
    await vi.advanceTimersByTimeAsync(50)
  }
  // Recorded after the output: a shell's 133;D retires an earlier launch record.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ptysById is OrcaRuntimeService's protected PTY record map.
  const ptys = (runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }).ptysById
  Object.assign(ptys.get(PTY_ID)!, {
    ...(launchAgent ? { launchAgent } : {}),
    ...(foregroundAgent ? { foregroundAgent } : {})
  })
  for (let send = 0; send < (setup.sends ?? 1); send += 1) {
    sentAt = Date.now()
    const sent = runtime.sendTerminal(
      handle,
      { text: 'claude', enter: true },
      { inputKind: 'driving' }
    )
    await vi.advanceTimersByTimeAsync(5000)
    await sent
  }
  return delays
}

const settled = (delays: number[]): boolean => delays.every((delay) => delay >= 500)

describe('terminal.send Enter settle on a plain shell', () => {
  afterEach(() => vi.useRealTimers())

  it('submits at once when markers and the host both show an idle shell', async () => {
    expect(await enterDelays({ output: IDLE_PROMPT })).toEqual([0])
  })

  it.each<[string, PaneSetup]>([
    ['a command is running', { output: `${A}$ ${B}sleep 9\r\n${C}` }],
    ['an agent was launched in the pane', { output: IDLE_PROMPT, launchAgent: 'claude' }],
    ['an agent holds the foreground', { output: IDLE_PROMPT, foregroundAgent: 'claude' }],
    ['the shell has no integration', { output: 'user@host:~$ ' }],
    ['nothing has been painted yet', {}],
    // Markers can be forged by any program; the execution host's foreground proof decides.
    [
      'the host says the shell is not in the foreground',
      { output: IDLE_PROMPT, shellForeground: false }
    ],
    ['the host cannot prove the foreground', { output: IDLE_PROMPT, shellForeground: null }],
    ['the host proof hangs', { output: IDLE_PROMPT, shellForeground: 'hang' }],
    [
      'the agent-status store has a row for the pane',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settle check reads only the row count.
      { output: IDLE_PROMPT, hookRows: [{ paneKey: 'tab-1:leaf-1' } as AgentStatusIpcPayload] }
    ]
  ])('keeps the settle when %s', async (_name, setup) => {
    expect(settled(await enterDelays(setup))).toBe(true)
  })

  // Review case 4: the first Enter starts a program, so the next send must not reuse that prompt.
  it('settles a back-to-back send that follows a fast submit', async () => {
    const [first, second] = await enterDelays({ output: IDLE_PROMPT, sends: 2 })
    expect(first).toBe(0)
    expect(second).toBeGreaterThanOrEqual(500)
  })
})
