import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/never-opened'

type WorktreeAnswerInternals = {
  getMobileSessionTabsForWorktree: (
    worktreeId: string,
    clientNavigationId?: string
  ) => RuntimeMobileSessionTabsResult
}

function createHeadedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests only reach listProcesses.
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  runtime.attachWindow(1)
  return runtime
}

function answerFor(runtime: OrcaRuntimeService, clientNavigationId?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own per-worktree answer.
  return (runtime as unknown as WorktreeAnswerInternals).getMobileSessionTabsForWorktree(
    WORKTREE,
    clientNavigationId
  )
}

function recordAnswers(runtime: OrcaRuntimeService): RuntimeMobileSessionTabsResult[] {
  const answers: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    if (snapshot.worktree === WORKTREE) {
      answers.push(snapshot)
    }
  }, 'device-1')
  return answers
}

function publishGraphWithoutWorktree(runtime: OrcaRuntimeService): void {
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
}

describe('answering for a worktree the host has no tabs for', () => {
  it('answers "ask me later" only until the renderer graph publishes', () => {
    const runtime = createHeadedRuntime()
    expect(answerFor(runtime)).toMatchObject({ publicationEpoch: 'none', tabs: [] })
    expect(answerFor(runtime, 'device-1')).toMatchObject({
      publicationEpoch: 'none:client-navigation',
      tabs: []
    })

    publishGraphWithoutWorktree(runtime)

    const published = answerFor(runtime, 'device-1')
    expect(published.publicationEpoch).not.toMatch(/^none/)
    expect(published.tabs).toEqual([])
  })

  it('tells a client that asked during startup once the graph publishes', () => {
    const runtime = createHeadedRuntime()
    const answers = recordAnswers(runtime)
    answerFor(runtime, 'device-1')
    answerFor(runtime, 'device-1')

    publishGraphWithoutWorktree(runtime)

    expect(answers).toHaveLength(1)
    expect(answers[0].publicationEpoch).not.toMatch(/^none/)
    expect(answers[0].tabs).toEqual([])
  })

  it('stays quiet when the publication carries the worktree itself', () => {
    const runtime = createHeadedRuntime()
    const answers = recordAnswers(runtime)
    answerFor(runtime, 'device-1')

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE,
          publicationEpoch: 'renderer-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect(
      answers.every((snapshot) => snapshot.publicationEpoch.startsWith('renderer-epoch'))
    ).toBe(true)
  })
})
