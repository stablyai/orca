import { afterEach, describe, expect, it, vi } from 'vitest'
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

type PaneSetup = { output?: string; launchAgent?: 'claude'; foregroundAgent?: 'claude' }

/** Milliseconds from send to the Enter write, after the pane painted `output`. */
async function enterDelayAfter({ output, launchAgent, foregroundAgent }: PaneSetup) {
  vi.useFakeTimers()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the repo/worktree members this fixture provides.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  let sentAt = 0
  let enterAt: number | null = null
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: (_ptyId, data) => {
      if (data === '\r') {
        enterAt = Date.now() - sentAt
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
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
  sentAt = Date.now()
  const sent = runtime.sendTerminal(handle, { text: 'ls', enter: true }, { inputKind: 'driving' })
  await vi.advanceTimersByTimeAsync(5000)
  await sent
  return enterAt
}

describe('terminal.send Enter settle on a plain shell', () => {
  afterEach(() => vi.useRealTimers())

  it('submits at once when the shell is idle at its prompt', async () => {
    expect(await enterDelayAfter({ output: IDLE_PROMPT })).toBe(0)
  })

  it.each<[string, PaneSetup]>([
    ['a command is running', { output: `${A}$ ${B}sleep 9\r\n${C}` }],
    ['an agent was launched in the pane', { output: IDLE_PROMPT, launchAgent: 'claude' }],
    ['an agent holds the foreground', { output: IDLE_PROMPT, foregroundAgent: 'claude' }],
    ['the shell has no integration', { output: 'user@host:~$ ' }],
    ['nothing has been painted yet', {}]
  ])('keeps the settle when %s', async (_name, setup) => {
    expect(await enterDelayAfter(setup)).toBeGreaterThanOrEqual(500)
  })
})
