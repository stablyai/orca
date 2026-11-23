import { describe, expect, it } from 'vitest'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import {
  isCurrentCommandStatus,
  isShellInFront,
  observeTerminalCommandPaint,
  type TerminalCommandPaintRecord
} from '../input/terminal-command-paint-record'
import { CommandFinishArbiter, commandMarkAgent } from './command-finish-arbiter'

const START = '\x1b]133;C\x07'
const FINISH = '\x1b]133;D;0\x07'

function pane(foreground: LaunchedAgentForeground) {
  const record: TerminalCommandPaintRecord = { launchCommandAgent: 'devin' }
  const finished: (number | null)[] = []
  const lane = (onFinish: (exitCode: number | null) => void) =>
    new CommandFinishArbiter({
      agentFor: () => commandMarkAgent(record),
      readForeground: async () => foreground,
      finish: (_ptyId, exitCode) => onFinish(exitCode),
      dismiss: () => record.commandPaint?.settleHeldFinish(false)
    })
  const authority = lane((exitCode) => finished.push(exitCode))
  const paint = lane(() => record.commandPaint?.settleHeldFinish(true))
  /** Feed bytes as the runtime does: the mark reaches both lanes. */
  const feed = async (data: string, at: number) => {
    if (data.includes(FINISH)) {
      authority.note('pty-1', 0)
    }
    if (observeTerminalCommandPaint(record, data, data, at)) {
      paint.note('pty-1', null)
    }
    await new Promise((settled) => setTimeout(settled, 0))
  }
  return { record, finished, feed }
}

describe('an OSC 133;D in a pane with an agent', () => {
  it("is the agent's own while the agent stays in front: its command and reports stay current", async () => {
    const { record, finished, feed } = pane('agent')
    await feed(`${START}devin`, 1_000)
    await feed(`READY${FINISH}❯ `, 2_000)

    expect(isShellInFront(record)).toBe(false)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(true)
    expect(finished).toEqual([])

    // Its next turn's own 133;C is mid-session, not a new command that retires the earlier title.
    await feed(`${START}thinking`, 3_000)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(true)
  })

  it("is the shell's once the read finds the shell: the command ends and its launch retires", async () => {
    const { record, finished, feed } = pane('shell')
    await feed(`${START}devin`, 1_000)
    await feed(`bye${FINISH}$ `, 2_000)

    expect(isShellInFront(record)).toBe(true)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(false)
    expect(finished).toEqual([0])
  })

  it('keeps the mark when the read cannot tell', async () => {
    const { record, finished, feed } = pane('unknown')
    await feed(`${START}devin`, 1_000)
    await feed(`bye${FINISH}$ `, 2_000)

    expect(isShellInFront(record)).toBe(true)
    expect(finished).toEqual([0])
  })

  it('reports nothing current while the read is still out', () => {
    const record: TerminalCommandPaintRecord = { launchCommandAgent: 'devin' }
    observeTerminalCommandPaint(record, `${START}devin`, 'devin', 1_000)
    expect(observeTerminalCommandPaint(record, FINISH, '', 2_000)).toBe(true)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(false)
  })
})

describe('an OSC 133;D in a pane with no agent', () => {
  it('ends the command at once, as before', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, `${START}make`, 'make', 1_000)
    expect(observeTerminalCommandPaint(record, `done${FINISH}`, 'done', 2_000)).toBe(false)
    expect(isShellInFront(record)).toBe(true)
  })
})
