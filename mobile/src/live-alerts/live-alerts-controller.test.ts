import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { Worktree } from '../worktree/workspace-list-types'
import type { LiveAlertPayload, LiveAlertShowResult } from './live-alert-types'
import { LiveAlertsController, startLiveAlertsController } from './live-alerts-controller'

const CLIENT = stubRpcClient()
const START = 1_000_000_000

type NativeCall =
  | { kind: 'show'; payload: LiveAlertPayload }
  | { kind: 'finish'; payload: LiveAlertPayload | null }
  | { kind: 'cancel' }

type Reply = (worktrees: readonly Worktree[] | null) => void

function row(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'opencode',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: 'Creating hello.txt now.',
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: START,
    updatedAt: START,
    ...overrides
  }
}

function rows(...agents: RuntimeWorktreeAgentRow[]): Worktree[] {
  return [
    {
      worktreeId: 'wt-1',
      repoId: 'repo-1',
      repo: 'demo-repo',
      branch: 'main',
      displayName: 'demo-repo',
      path: '/repo',
      liveTerminalCount: 1,
      hasAttachedPty: true,
      unread: false,
      isPinned: false,
      linkedPR: null,
      agents
    }
  ]
}

function last<T>(items: readonly T[]): T | undefined {
  return items.at(-1)
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function harness(showResult: LiveAlertShowResult = 'foreground-service') {
  let now = START
  let connected = true
  const replies: Reply[] = []
  const calls: NativeCall[] = []
  const keepAlive: boolean[] = []
  const controller = new LiveAlertsController({
    now: () => now,
    fetchRows: () =>
      new Promise((resolve) => {
        replies.push(resolve)
      }),
    listClients: () => [{ hostId: 'host-1', client: CLIENT }],
    isConnected: () => connected,
    hostName: () => 'Desk',
    isForeground: () => true,
    native: {
      show: async (payload) => {
        calls.push({ kind: 'show', payload })
        return showResult
      },
      finish: async (payload) => {
        calls.push({ kind: 'finish', payload })
      },
      cancel: async () => {
        calls.push({ kind: 'cancel' })
      }
    },
    setKeepAlive: (active) => {
      keepAlive.push(active)
    }
  })
  controller.setPreferences({ enabled: true })
  return {
    controller,
    replies,
    calls,
    keepAlive,
    shown: () => calls.flatMap((call) => (call.kind === 'show' ? [call.payload] : [])),
    advance: (ms: number) => {
      now += ms
    },
    disconnect: () => {
      connected = false
    },
    /** One tick whose read answers with `worktrees`. */
    poll: async (worktrees: readonly Worktree[]) => {
      controller.tick()
      replies.shift()?.(worktrees)
      await flush()
    }
  }
}

describe('LiveAlertsController', () => {
  it('posts the live notification when an agent starts working', async () => {
    const h = harness()
    await h.poll(rows(row()))
    expect(h.shown()).toMatchObject([{ title: 'Agent working', text: 'Creating hello.txt now.' }])
    expect(last(h.keepAlive)).toBe(true)
  })

  it('does not call native again while nothing changes', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.advance(3_000)
    await h.poll(rows(row()))
    expect(h.calls).toHaveLength(1)
  })

  it('keeps the precise ask of a waiting agent', async () => {
    const h = harness()
    await h.poll(rows(row({ state: 'waiting', toolName: 'bash', toolInput: 'npm test' })))
    expect(last(h.shown())).toMatchObject({ title: 'Needs your approval', chipText: 'Approve' })
    expect(last(h.shown())?.text).toBe('Allow command: npm test')
  })

  it('lingers on Done for 10 s, then leaves the final notification', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.advance(3_000)
    await h.poll(rows(row({ state: 'done', lastAssistantMessage: 'Created hello.txt.' })))
    expect(last(h.calls)).toMatchObject({ kind: 'show', payload: { phase: 'lingering' } })
    expect(last(h.keepAlive)).toBe(true)
    h.advance(10_000)
    await h.poll(rows(row({ state: 'done', lastAssistantMessage: 'Created hello.txt.' })))
    const final = { phase: 'final', title: 'Done', text: 'Created hello.txt.' }
    expect(last(h.calls)).toMatchObject({ kind: 'finish', payload: final })
    expect(last(h.keepAlive)).toBe(false)
  })

  it('keeps one session when the agent starts another turn during the linger', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.advance(3_000)
    await h.poll(rows(row({ state: 'done' })))
    h.advance(3_000)
    await h.poll(rows(row({ lastAssistantMessage: 'Running the tests next.' })))
    expect(new Set(h.shown().map((payload) => payload.startedAt)).size).toBe(1)
    expect(last(h.calls)).toMatchObject({ kind: 'show', payload: { phase: 'working' } })
    expect(h.calls.some((call) => call.kind === 'finish')).toBe(false)
  })

  it('stays quiet after a dismissal until the agents are idle', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.controller.dismissed()
    await flush()
    expect(last(h.calls)?.kind).toBe('cancel')
    expect(last(h.keepAlive)).toBe(false)
    h.advance(10_000)
    await h.poll(rows(row({ lastAssistantMessage: 'Still going.' })))
    expect(h.shown()).toHaveLength(1)
    h.advance(10_000)
    await h.poll(rows(row({ state: 'done' })))
    h.advance(10_000)
    await h.poll(rows(row({ lastAssistantMessage: 'A new task.' })))
    expect(h.shown()).toHaveLength(2)
  })

  it('removes the notification when the setting is turned off', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.controller.setPreferences({ enabled: false })
    await flush()
    expect(last(h.calls)?.kind).toBe('cancel')
    expect(last(h.keepAlive)).toBe(false)
  })

  it('reports a lost desktop, then ends after 90 s without fresh rows', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.disconnect()
    h.advance(31_000)
    h.controller.tick()
    await flush()
    expect(last(h.calls)).toMatchObject({ kind: 'show', payload: { title: 'Disconnected' } })
    h.advance(60_000)
    h.controller.tick()
    await flush()
    expect(last(h.calls)).toMatchObject({ kind: 'finish', payload: { title: 'Disconnected' } })
    expect(h.replies).toHaveLength(0)
  })

  it('abandons a read that stalls and uses the next one', async () => {
    const h = harness()
    await h.poll(rows(row()))
    h.advance(3_000)
    h.controller.tick()
    h.advance(3_000)
    h.controller.tick()
    expect(h.replies).toHaveLength(1)
    h.advance(12_000)
    h.controller.tick()
    expect(h.replies).toHaveLength(2)
    h.replies[1](rows(row({ state: 'done' })))
    await flush()
    h.replies[0](rows(row({ lastAssistantMessage: 'An old reply.' })))
    await flush()
    expect(last(h.calls)).toMatchObject({ kind: 'show', payload: { phase: 'lingering' } })
  })

  it('stops trying while notifications are unavailable', async () => {
    const h = harness('unavailable')
    await h.poll(rows(row()))
    expect(last(h.calls)?.kind).toBe('cancel')
    h.advance(10_000)
    await h.poll(rows(row({ lastAssistantMessage: 'More work.' })))
    expect(h.shown()).toHaveLength(1)
    expect(last(h.keepAlive)).toBe(false)
  })
})

describe('startLiveAlertsController', () => {
  it('ticks from its sources, follows preferences and cancels when stopped', async () => {
    const h = harness()
    const hooks: { nativeTick?: () => void; active?: () => void; dismissed?: () => void } = {}
    const stop = startLiveAlertsController(h.controller, {
      scheduleRepeating: () => () => {},
      subscribeAppActive: (onActive) => {
        hooks.active = onActive
        return () => {}
      },
      subscribeNativeTick: (onTick) => {
        hooks.nativeTick = onTick
        return () => {}
      },
      subscribeDismissed: (onDismissed) => {
        hooks.dismissed = onDismissed
        return () => {}
      },
      subscribePreferences: () => () => {},
      loadPreferences: async () => ({ enabled: true })
    })
    await flush()
    expect(h.replies).toHaveLength(1)
    h.replies.shift()?.(rows(row()))
    await flush()
    expect(h.shown()).toHaveLength(1)
    h.advance(3_000)
    hooks.nativeTick?.()
    expect(h.replies).toHaveLength(1)
    hooks.dismissed?.()
    await flush()
    expect(last(h.calls)?.kind).toBe('cancel')
    stop()
    await flush()
    expect(h.calls.filter((call) => call.kind === 'cancel')).toHaveLength(2)
  })
})
