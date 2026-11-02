import { describe, expect, it, vi } from 'vitest'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import type { WslMoveExitProof } from './wsl-move-exit-proof'
import {
  quiesceWslMove,
  type WslMoveQuiesceDeps,
  type WslMoveQuiesceScope
} from './wsl-move-quiesce'
import type { WslMovePaneFacts } from './wsl-move-terminal-gate'

const WORKTREE = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'
const scope: WslMoveQuiesceScope = {
  workspaceIds: [WORKTREE],
  workspaceKeys: new Set([WORKTREE]),
  panes: [{ paneKey: 'tab-1:leaf-1', sessionId: 'session-1' }]
}
const idlePane: WslMovePaneFacts = {
  paneKey: 'tab-1:leaf-1',
  foreground: 'shell-idle',
  scrollbackBytes: 10
}
const hints = {
  hints: [{ paneKey: 'tab-1:leaf-1', cwd: '/home/dev/repo-1' }],
  unreadablePaneKeys: [],
  staleCwdPaneKeys: []
}

function harness(overrides: Partial<WslMoveQuiesceDeps> = {}) {
  const journal: WslMoveCutover['phase'][] = []
  const removed: string[] = []
  const steps: string[] = []
  const deps: WslMoveQuiesceDeps = {
    gateInputs: async () => ({
      panes: [idlePane],
      runningAutomationRunIds: [],
      activeDispatchIds: []
    }),
    sleepWorkspaces: vi.fn(async () => {
      steps.push(`sleep after ${journal.at(-1)}`)
      return { failedWorktreeIds: [] }
    }),
    livePtyIds: () => [],
    captureRestoreHints: async () => hints,
    proveExited: async (): Promise<WslMoveExitProof> => ({ verdict: 'exited' }),
    writeCutover: (record) => {
      journal.push(record.phase)
    },
    removeCutover: (migrationId) => {
      removed.push(migrationId)
    },
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    ...overrides
  }
  return { deps, journal, removed, steps }
}

describe('quiesceWslMove', () => {
  it('fences, sleeps, proves exit and records the proven sessions', async () => {
    const { deps, journal, removed, steps } = harness()
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(journal).toEqual(['source-fenced', 'quiesced'])
    expect(steps).toEqual(['sleep after source-fenced'])
    expect(removed).toEqual([])
    expect(result).toMatchObject({
      outcome: 'quiesced',
      cutover: { phase: 'quiesced', provenExitedSessionIds: ['session-1'] },
      restoreHints: hints
    })
  })

  it('refuses with the blockers before fencing anything', async () => {
    const { deps, journal } = harness({
      gateInputs: async () => ({
        panes: [{ ...idlePane, foreground: 'process-running' }],
        runningAutomationRunIds: [],
        activeDispatchIds: []
      })
    })
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'terminals-blocked',
      blockers: [{ kind: 'process-running', ids: ['tab-1:leaf-1'] }],
      fenceLifted: true
    })
    expect(journal).toEqual([])
    expect(deps.sleepWorkspaces).not.toHaveBeenCalled()
  })

  it('gates again under the fence and refuses a pane that turned busy, without sleeping', async () => {
    const phases: (WslMoveCutover['phase'] | undefined)[] = []
    let calls = 0
    const { deps, journal, removed } = harness()
    deps.gateInputs = async () => {
      phases.push(journal.at(-1))
      calls += 1
      const foreground = calls === 1 ? 'shell-idle' : 'process-running'
      return {
        panes: [{ ...idlePane, foreground }],
        runningAutomationRunIds: [],
        activeDispatchIds: []
      }
    }
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(phases).toEqual([undefined, 'source-fenced'])
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'terminals-blocked',
      blockers: [{ kind: 'process-running', ids: ['tab-1:leaf-1'] }],
      fenceLifted: true
    })
    expect(deps.sleepWorkspaces).not.toHaveBeenCalled()
    expect(removed).toEqual(['move-1'])
  })

  it('refuses a second quiesce of the same distro while the first runs', async () => {
    let releaseSleep: () => void = () => undefined
    const first = harness({
      sleepWorkspaces: () =>
        new Promise((resolve) => {
          releaseSleep = () => resolve({ failedWorktreeIds: [] })
        })
    })
    const running = quiesceWslMove(cutover(), scope, first.deps)
    await vi.waitFor(() => expect(first.journal).toEqual(['source-fenced']))

    const second = harness()
    await expect(quiesceWslMove(cutover('move-2'), scope, second.deps)).resolves.toEqual({
      outcome: 'refused',
      reason: 'quiesce-in-progress',
      fenceLifted: true
    })
    expect(second.journal).toEqual([])

    releaseSleep()
    await expect(running).resolves.toMatchObject({ outcome: 'quiesced' })
    await expect(quiesceWslMove(cutover('move-2'), scope, second.deps)).resolves.toMatchObject({
      outcome: 'quiesced'
    })
  })

  it.each([
    ['renderer_unavailable', 'renderer-unavailable'],
    ['worktree_sleep_timeout', 'sleep-timed-out'],
    ['persist failed', 'sleep-failed']
  ])('lifts the fence when Sleep rejects with %s', async (message, reason) => {
    const { deps, journal, removed } = harness({
      sleepWorkspaces: async () => {
        throw new Error(message)
      }
    })
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(result).toMatchObject({ outcome: 'refused', reason, fenceLifted: true })
    expect(journal).toEqual(['source-fenced'])
    expect(removed).toEqual(['move-1'])
  })

  it('lifts the fence and names the workspaces whose Sleep failed', async () => {
    const { deps, removed } = harness({
      sleepWorkspaces: async () => ({ failedWorktreeIds: [WORKTREE] })
    })
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'sleep-failed',
      failedWorktreeIds: [WORKTREE]
    })
    expect(removed).toEqual(['move-1'])
  })

  it('refuses a terminal opened in scope after Sleep, without touching the daemon proof', async () => {
    const proveExited = vi.fn(async (): Promise<WslMoveExitProof> => ({ verdict: 'exited' }))
    const { deps, journal, removed } = harness({ livePtyIds: () => ['pty-new'], proveExited })
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(result).toMatchObject({ reason: 'terminals-live', liveSessionIds: ['pty-new'] })
    expect(proveExited).not.toHaveBeenCalled()
    expect(journal).toEqual(['source-fenced'])
    expect(removed).toEqual(['move-1'])
  })

  it.each<[WslMoveExitProof, Record<string, unknown>]>([
    [
      { verdict: 'live', sessionIds: ['session-1'] },
      { reason: 'terminals-live', liveSessionIds: ['session-1'] }
    ],
    [
      { verdict: 'unverifiable', reason: 'a daemon generation did not answer' },
      { reason: 'exit-unverifiable', detail: 'a daemon generation did not answer' }
    ]
  ])('refuses unless the daemon proves exit: %o', async (proof, expected) => {
    const { deps, journal, removed } = harness({ proveExited: async () => proof })
    const result = await quiesceWslMove(cutover(), scope, deps)

    expect(result).toMatchObject({ outcome: 'refused', ...expected, fenceLifted: true })
    expect(journal).toEqual(['source-fenced'])
    expect(removed).toEqual(['move-1'])
  })

  it('lifts the fence when reading the restore hints throws', async () => {
    const { deps, removed } = harness({
      captureRestoreHints: async () => {
        throw new Error('disk')
      }
    })
    const result = await quiesceWslMove(cutover(), scope, deps)
    expect(result).toMatchObject({ reason: 'quiesce-failed', detail: 'disk' })
    expect(removed).toEqual(['move-1'])
  })

  it('reports a fence it could not lift', async () => {
    const { deps } = harness({
      proveExited: async () => ({ verdict: 'live', sessionIds: ['session-1'] }),
      removeCutover: () => {
        throw new Error('wsl_move_in_flight')
      }
    })
    const result = await quiesceWslMove(cutover(), scope, deps)
    expect(result).toMatchObject({ outcome: 'refused', fenceLifted: false })
  })

  it('refuses without lifting anything when the fence cannot be written', async () => {
    const { deps, removed } = harness({
      writeCutover: () => {
        throw new Error('wsl_move_already_in_flight')
      }
    })
    const result = await quiesceWslMove(cutover(), scope, deps)
    expect(result).toMatchObject({ reason: 'fence-failed', fenceLifted: true })
    expect(removed).toEqual([])
    expect(deps.sleepWorkspaces).not.toHaveBeenCalled()
  })

  it('only starts from a prepared move', async () => {
    const { deps } = harness()
    await expect(quiesceWslMove(cutover('move-1', 'source-fenced'), scope, deps)).rejects.toThrow(
      'wsl_move_not_prepared'
    )
  })
})
