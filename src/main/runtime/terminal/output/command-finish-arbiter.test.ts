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

/** A Devin pane wired as the runtime wires it: the byte path's mark reaches authority, then command paint. */
function devinPane() {
  const record: TerminalCommandPaintRecord & { incarnationId: string } = {
    launchCommandAgent: 'devin',
    incarnationId: 'a'
  }
  const retired: (number | null)[] = []
  let answer: (foreground: LaunchedAgentForeground) => void = () => {}
  const arbiter = new CommandFinishArbiter({
    agentFor: () => commandMarkAgent(record),
    incarnationOf: () => record.incarnationId,
    readForeground: () => new Promise((resolve) => (answer = resolve)),
    finish: (_ptyId, lanes) => {
      if (lanes.paint) {
        record.commandPaint?.settleHeldFinish(true)
      }
      if (lanes.authority) {
        retired.push(lanes.authority.exitCode)
      }
    },
    dismiss: (_ptyId, lanes) => {
      if (lanes.paint) {
        record.commandPaint?.settleHeldFinish(false)
      }
    }
  })
  const feed = (data: string, at: number) => {
    if (data.includes(START)) {
      arbiter.noteCommandStarted('pty-1', 'authority')
    }
    if (data.includes(FINISH)) {
      arbiter.note('pty-1', { authority: { exitCode: 0 } })
    }
    const marks = observeTerminalCommandPaint(record, data, data, at)
    if (marks.heldFinishStarted) {
      arbiter.noteCommandStarted('pty-1', 'paint')
    }
    if (marks.finishHeld) {
      arbiter.note('pty-1', { paint: true })
    }
  }
  const settle = async (foreground: LaunchedAgentForeground) => {
    answer(foreground)
    await new Promise((done) => setTimeout(done, 0))
  }
  return { record, retired, feed, settle, arbiter }
}

describe('an OSC 133;D in a pane with an agent', () => {
  it("is the agent's own while that agent stays in front: nothing retires", async () => {
    const { record, retired, feed, settle } = devinPane()
    feed(`${START}devin`, 1_000)
    feed(`READY${FINISH}❯ `, 2_000)
    // Until the read answers, the finished program's reports may be the shell's.
    expect(isCurrentCommandStatus(record, 1_500)).toBe(false)

    await settle('agent')
    expect(isShellInFront(record)).toBe(false)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(true)
    expect(retired).toEqual([])

    // Its next turn's own 133;C is mid-session, not a new command retiring the earlier title.
    feed(`${START}thinking`, 3_000)
    expect(isCurrentCommandStatus(record, 1_500)).toBe(true)
  })

  it("is the shell's once the read finds anything but the agent: the command ends and its launch retires", async () => {
    for (const foreground of ['shell', 'unknown'] as const) {
      const { record, retired, feed, settle } = devinPane()
      feed(`${START}devin`, 1_000)
      feed(`bye${FINISH}$ `, 2_000)
      await settle(foreground)
      expect(isShellInFront(record)).toBe(true)
      expect(retired).toEqual([0])
    }
  })

  it('counts as before when a command starts before the read answers', async () => {
    const { record, retired, feed, settle } = devinPane()
    feed(`${START}devin`, 1_000)
    feed(`bye${FINISH}$ `, 2_000)
    feed(`${START}make`, 3_000)
    expect(retired).toEqual([0])
    expect(isCurrentCommandStatus(record, 3_500)).toBe(true)

    // The late answer finds nothing left to decide.
    await settle('agent')
    expect(retired).toEqual([0])
    expect(isCurrentCommandStatus(record, 3_500)).toBe(true)
  })

  it('retires nothing for a process that replaced the one whose mark it was', async () => {
    const { record, retired, feed, settle } = devinPane()
    feed(`${START}devin`, 1_000)
    feed(`bye${FINISH}`, 2_000)
    record.incarnationId = 'b'
    await settle('unknown')
    expect(retired).toEqual([])
    expect(isCurrentCommandStatus(record, 2_500)).toBe(true)
  })
})

describe('lanes reading bytes at their own pace', () => {
  it("does not take a start the tracker reads late, from before the agent's mark, as the shell's", async () => {
    const { record, retired, arbiter, settle } = devinPane()
    observeTerminalCommandPaint(record, `${START}devin`, 'devin', 1_000)
    // Command paint reads the turn's own start and end before the lagging tracker reads that start.
    observeTerminalCommandPaint(record, `${START}go`, 'go', 2_000)
    const marks = observeTerminalCommandPaint(record, `READY${FINISH}`, 'READY', 3_000)
    expect(marks.finishHeld).toBe(true)
    arbiter.note('pty-1', { paint: true })
    arbiter.noteCommandStarted('pty-1', 'authority')
    arbiter.note('pty-1', { authority: { exitCode: 0 } })
    await settle('agent')
    expect(isShellInFront(record)).toBe(false)
    expect(isCurrentCommandStatus(record, 2_500)).toBe(true)
    expect(retired).toEqual([])
  })
})

describe('a mark a replaced process left', () => {
  it('is dismissed when the new process starts a command', async () => {
    const { record, retired, feed, settle } = devinPane()
    feed(`${START}devin`, 1_000)
    feed(`bye${FINISH}`, 2_000)
    record.incarnationId = 'b'
    feed(`${START}codex`, 3_000)
    await settle('unknown')
    expect(retired).toEqual([])
  })
})

describe('an OSC 133;D in a pane with no agent', () => {
  it('ends the command at once, as before', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, `${START}make`, 'make', 1_000)
    expect(observeTerminalCommandPaint(record, `done${FINISH}`, 'done', 2_000).finishHeld).toBe(
      false
    )
    expect(isShellInFront(record)).toBe(true)
  })
})
