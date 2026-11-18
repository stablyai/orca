import { describe, expect, it, vi } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  observeTerminalCommandPaint,
  vouchTerminalSpawn,
  type TerminalCommandPaintRecord
} from '../input/terminal-command-paint'
import { reattachedRestTitleAgent } from './reattached-rest-title'
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
  const LOCAL = { remote: false }
  const readAgent = { readLaunchedAgentForeground: async () => 'agent' as const }

  it('needs the fresh process name to be that agent, not only a non-shell', async () => {
    const named = (name: string) => ({
      supportsForegroundObservation: () => true,
      confirmForegroundProcess: async () => name
    })
    await expect(
      readExactAgentForeground(readAgent, named('claude'), LOCAL, 'pty-1', 'claude')
    ).resolves.toBe('agent')
    await expect(
      readExactAgentForeground(readAgent, named('less'), LOCAL, 'pty-1', 'claude')
    ).resolves.toBe('unknown')
  })

  it('reads only the owner-held name on a local owner without foreground observation', async () => {
    const groupRead = vi.fn(async () => 'agent' as const)
    const oldOwner = {
      supportsForegroundObservation: () => false,
      confirmForegroundProcess: async () => 'claude'
    }
    const runtime = { readLaunchedAgentForeground: groupRead }
    await expect(
      readExactAgentForeground(runtime, oldOwner, LOCAL, 'pty-1', 'claude')
    ).resolves.toBe('agent')
    await expect(
      readExactAgentForeground(runtime, oldOwner, LOCAL, 'pty-1', 'codex')
    ).resolves.toBe('unknown')
    expect(groupRead).not.toHaveBeenCalled()
  })
})
