import { describe, expect, it, vi } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  observeTerminalCommandPaint,
  vouchTerminalSpawn,
  type TerminalCommandPaintRecord
} from '../input/terminal-command-paint'
import { ReattachedRestTitleReads, reattachedRestTitleAgent } from './reattached-rest-title'
import { readExactAgentForeground } from './launched-agent-foreground'

const REST_TITLE = '✳ Claude Code'
const FINISH = '\x1b]133;D;0\x07'

function seededPane(): TerminalCommandPaintRecord & {
  lastOscTitle: string
  lastOscTitleEpochMs: null
} {
  return { lastOscTitle: REST_TITLE, lastOscTitleEpochMs: null }
}

describe("a reattached pane's retained rest title", () => {
  it('names its agent while the reattached command is still the one running', () => {
    const pane = seededPane()
    awaitReattachedTerminalPaint(pane, 1_000)
    expect(reattachedRestTitleAgent(pane)).toBe('claude')
  })

  it('names nobody once that command finished, or for a process this run saw start', () => {
    const finished = seededPane()
    awaitReattachedTerminalPaint(finished, 1_000)
    observeTerminalCommandPaint(finished, FINISH, FINISH, 2_000)
    expect(reattachedRestTitleAgent(finished)).toBeNull()

    const spawned = seededPane()
    vouchTerminalSpawn(spawned)
    awaitReattachedTerminalPaint(spawned, 1_000)
    expect(reattachedRestTitleAgent(spawned)).toBeNull()
  })
})

describe('reading that the agent itself is in front', () => {
  const readAgent = { readLaunchedAgentForeground: async () => 'agent' as const }

  it('needs the fresh process name to be that agent, not only a non-shell', async () => {
    const named = (name: string) => ({ confirmForegroundProcess: async () => name })
    await expect(
      readExactAgentForeground(readAgent, named('claude'), 'pty-1', 'claude')
    ).resolves.toBe('agent')
    await expect(
      readExactAgentForeground(readAgent, named('less'), 'pty-1', 'claude')
    ).resolves.toBe('unknown')
  })
})

describe('rest-title reads on a quiet reattached pane', () => {
  it('reads again once discovery stores the root an old owner needs, not before the retry', async () => {
    const pane: ReturnType<typeof seededPane> & {
      ptyId: string
      adoptedRootProcess?: { pid: number } | null
    } = { ...seededPane(), ptyId: 'pty-1' }
    awaitReattachedTerminalPaint(pane, 1_000)
    const confirm = vi.fn(async () => false)
    const reads = new ReattachedRestTitleReads(() => 5_000, confirm)

    await reads.confirm(pane)
    expect(reads.confirm(pane)).toBeNull()
    pane.adoptedRootProcess = { pid: 4_242 }
    await reads.confirm(pane)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
