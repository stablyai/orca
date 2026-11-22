import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'
import { readPairedHandedAgents, type BotPairedRuntime } from './bot-paired-handed-agents'

const agent = {
  paneKey: 'tab-1:pane-1',
  state: 'blocked',
  prompt: 'May I push?',
  taskTitle: null,
  stateStartedAt: 7
}

function row(worktreeId: string, parentKey: string, agents = [agent]) {
  return {
    worktreeId,
    crossStoreParent: {
      parent: { installationId: 'desk', workspaceKey: parentKey, instanceId: 'i' }
    },
    agents
  }
}

function runtimeAnswering(answer: () => Promise<unknown>) {
  let saved: Bot | null = null
  const runtime = {
    callOrchestrationWorkerServer: vi.fn(answer),
    bots: {
      update: vi.fn(async (_id: string, edit: (bot: Bot) => Partial<Bot>) => {
        saved = { ...bot, ...edit(bot) }
        return saved
      })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only these two.
  return { runtime: runtime as unknown as BotPairedRuntime, calls: runtime, saved: () => saved }
}

const bot = makeTestBot({
  folderWorkspaceId: 'home-1',
  handedPairedWorkspaces: [
    { environmentId: 'env-1', worktreeId: 'wt-here' },
    { environmentId: 'env-1', worktreeId: 'wt-gone' }
  ]
})

describe('readPairedHandedAgents', () => {
  it("reports the agents of the paired computer's workspaces still under the bot's home, with their host", async () => {
    const { runtime, calls, saved } = runtimeAnswering(async () => ({
      worktrees: [row('wt-here', 'folder:home-1'), row('wt-gone', 'folder:other-home')]
    }))
    const agents = await readPairedHandedAgents(runtime, bot, 1_000)
    expect(agents).toEqual([
      {
        paneKey: 'tab-1:pane-1',
        entry: { state: 'blocked', prompt: 'May I push?', stateStartedAt: 7 },
        worktreeId: 'wt-here',
        hostId: 'runtime:env-1'
      }
    ])
    expect(calls.callOrchestrationWorkerServer).toHaveBeenCalledTimes(1)
    // Moved under another parent there: forgotten.
    await vi.waitFor(() =>
      expect(saved()?.handedPairedWorkspaces).toEqual([
        { environmentId: 'env-1', worktreeId: 'wt-here' }
      ])
    )
  })
})

describe('readPairedHandedAgents, a computer that is away', () => {
  it('shows a paired agent after the reconnect backoff', async () => {
    let online = false
    const { runtime, calls } = runtimeAnswering(async () => {
      if (!online) {
        throw new Error('offline')
      }
      return { worktrees: [row('wt-here', 'folder:home-1')] }
    })
    expect(await readPairedHandedAgents(runtime, bot, 0)).toEqual([])
    expect(await readPairedHandedAgents(runtime, bot, 5_000)).toEqual([])
    expect(calls.bots.update).not.toHaveBeenCalled()

    online = true
    expect(await readPairedHandedAgents(runtime, bot, 12_000)).toEqual([])
    expect(await readPairedHandedAgents(runtime, bot, 16_000)).toMatchObject([
      { worktreeId: 'wt-here', hostId: 'runtime:env-1' }
    ])
  })
})

describe('readPairedHandedAgents, an answer older than the hand-over', () => {
  it("never forgets a hand-over because of a read asked before it (Codex's repro)", async () => {
    let parent = 'folder:home-A'
    const calls = vi.fn(async () => ({ worktrees: [row('wt-1', parent)] }))
    let saved = makeTestBot({
      id: 'bot-B',
      folderWorkspaceId: 'home-B',
      handedPairedWorkspaces: []
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only these two.
    const runtime = {
      callOrchestrationWorkerServer: calls,
      bots: {
        update: vi.fn(async (_id: string, edit: (bot: Bot) => Partial<Bot>) => {
          saved = { ...saved, ...edit(saved) }
          return saved
        })
      }
    } as unknown as BotPairedRuntime
    const botA = makeTestBot({
      id: 'bot-A',
      folderWorkspaceId: 'home-A',
      handedPairedWorkspaces: [{ environmentId: 'env-1', worktreeId: 'wt-1', at: 0 }]
    })

    // Bot A's Activity reads the computer while the workspace is under A.
    expect(await readPairedHandedAgents(runtime, botA, 1_000)).toHaveLength(1)
    // The workspace is handed to B, and B registers it, after that read.
    parent = 'folder:home-B'
    saved = {
      ...saved,
      handedPairedWorkspaces: [{ environmentId: 'env-1', worktreeId: 'wt-1', at: 1_000.5 }]
    }
    // B's read within the reuse window gets A's cached answer: no proof of a move away.
    expect(await readPairedHandedAgents(runtime, saved, 1_001)).toEqual([])
    expect(calls).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saved.handedPairedWorkspaces).toHaveLength(1)
    // Once that answer expires, B sees its agent.
    expect(await readPairedHandedAgents(runtime, saved, 20_000)).toHaveLength(1)
  })
})
