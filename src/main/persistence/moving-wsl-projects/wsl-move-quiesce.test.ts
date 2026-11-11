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
  noCwdPaneKeys: [],
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
    wait: async () => {},
    ...overrides
  }
  return { deps, journal, removed, steps }
}

describe('quiesceWslMove', () => {
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
    let signalSleepStarted: () => void = () => undefined
    const sleepStarted = new Promise<void>((resolve) => {
      signalSleepStarted = resolve
    })
    const first = harness({
      sleepWorkspaces: () =>
        new Promise((resolve) => {
          releaseSleep = () => resolve({ failedWorktreeIds: [] })
          signalSleepStarted()
        })
    })
    const running = quiesceWslMove(cutover(), scope, first.deps)
    await sleepStarted
    expect(first.journal).toEqual(['source-fenced'])

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

  // A just-slept workspace's first stop failed once and the move refused.
})
