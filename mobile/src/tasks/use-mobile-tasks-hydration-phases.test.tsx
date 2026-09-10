import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The hook reaches the Tasks barrels, which pull React Native in. Only the helpers this path
// runs before the settings fan-out matter, and the fan-out fails first in every case here.
vi.mock('./mobile-tasks-dependencies', () => ({
  filterAvailableTaskProviders: (providers: unknown) => providers,
  isHostedTaskRepo: () => true,
  normalizeVisibleTaskProviders: () => ['github'],
  reconcileRepoSelection: () => new Set<string>(),
  resolveVisibleTaskProvider: () => 'github',
  useEffect
}))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  EMPTY_GITHUB_PROJECT_SETTINGS: {},
  getTaskPresetQuery: () => '',
  githubKindFromQuery: () => 'issues',
  isTaskProvider: () => true,
  normalizeGitHubPreset: () => 'issues',
  normalizeLinearFilter: () => 'assigned',
  scopeGitHubTaskSearch: (query: string) => query
}))

const { useMobileTasksRuntimeHydration } = await import('./use-mobile-tasks-runtime-hydration')

const client = { id: 'client-1' }

/** 74 model fields reach this hook and only a handful steer this path, so anything unnamed
 *  answers with a spy. */
function taskModel(taskOperations: unknown, recorded: Record<string, ReturnType<typeof vi.fn>>) {
  const fixed: Record<string, unknown> = {
    client,
    connState: 'connected',
    taskOperations,
    provider: 'github',
    repoList: { state: { status: 'idle' }, repos: [], loading: false },
    repos: [],
    requestedTaskSource: undefined,
    visibleProviders: ['github'],
    defaultLinearTeamSelectionRef: { current: null },
    defaultRepoSelectionRef: { current: null },
    repoSelectionHydratedRef: { current: false },
    taskResumeRef: { current: {} }
  }
  return new Proxy(fixed, {
    get(target, property: string) {
      if (property in target) {
        return target[property]
      }
      recorded[property] ??= vi.fn()
      return recorded[property]
    },
    has: () => true
  })
}

describe('tasks runtime hydration phases', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders a supported screen behind the error when the settings fan-out fails', async () => {
    const recorded: Record<string, ReturnType<typeof vi.fn>> = {}
    const taskOperations = {
      read: {
        tasksSupported: vi.fn().mockResolvedValue(true),
        // The second phase is what a post-connect timeout on `preflight.check` rejects.
        bootstrap: vi.fn().mockRejectedValue(new Error('Request timed out: preflight.check'))
      }
    }

    function Probe(): null {
      useMobileTasksRuntimeHydration(taskModel(taskOperations, recorded) as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Committed between the two phases. Folding them behind one await leaves this at 'unknown',
    // which the list surface renders as a bare spinner with no path back.
    expect(recorded.setTasksSupportState).toHaveBeenCalledWith({ kind: 'supported', client })
    expect(recorded.setError).toHaveBeenCalledWith('Request timed out: preflight.check')
    expect(taskOperations.read.bootstrap).toHaveBeenCalledTimes(1)
  })
})
