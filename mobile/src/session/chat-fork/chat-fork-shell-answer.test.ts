import { describe, expect, it, vi } from 'vitest'
import type { MobileChatForkSheetSource } from './MobileChatForkSheet'
import { settleShellAnswer } from './chat-fork-shell-answer'

const source: MobileChatForkSheetSource = {
  hostId: 'host-a',
  worktreeId: 'wt-1',
  client: null,
  capabilities: [],
  agent: 'claude',
  surface: 'chat',
  usageLimited: false,
  canCopy: true,
  canExport: false,
  canNewWorktree: true,
  canSubagent: false
}
const forkFrom = { sessionId: 'session-1', throughItemId: 'item-9' }
const target = {
  hostId: 'host-a',
  hostLabel: 'Desk A',
  workspace: { kind: 'this' as const },
  agent: 'codex' as const,
  runAs: 'open' as const,
  path: 'recap' as const,
  openAs: 'chat' as const,
  recapScope: 'history' as const
}

function deps() {
  return { copyOffered: () => true, runHere: vi.fn(async () => {}), showToast: vi.fn() }
}

describe('what the page does with the app Fork sheet answer', () => {
  it('runs a fork chosen for its own host itself', async () => {
    const run = deps()
    await settleShellAnswer({ outcome: 'here', target }, source, forkFrom, run)
    expect(run.runHere).toHaveBeenCalledWith(
      'claude',
      { ...target, hostCapabilities: undefined },
      forkFrom
    )
  })

  it('never runs a fork the answer places on another host', async () => {
    const run = deps()
    await settleShellAnswer(
      { outcome: 'here', target: { ...target, hostId: 'host-b' } },
      source,
      forkFrom,
      run
    )
    await settleShellAnswer(
      {
        outcome: 'here',
        target: {
          ...target,
          workspace: { kind: 'existing', hostId: 'host-b', worktreeId: 'wt-2', name: 'b' }
        }
      },
      source,
      forkFrom,
      run
    )
    expect(run.runHere).not.toHaveBeenCalled()
    expect(run.showToast).toHaveBeenCalledTimes(2)
  })

  it('shows what the app reported for a fork it ran on another host', async () => {
    const run = deps()
    await settleShellAnswer(
      { outcome: 'done', notices: ['Couldn’t open Codex on Desk B'] },
      source,
      forkFrom,
      run
    )
    expect(run.runHere).not.toHaveBeenCalled()
    expect(run.showToast).toHaveBeenCalledWith('Couldn’t open Codex on Desk B', 4000)
  })
})
