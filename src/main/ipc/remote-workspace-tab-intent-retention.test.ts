import { describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceTabObservation
} from '../../shared/remote-workspace-types'
import { RemoteWorkspaceTabIntentStore } from './remote-workspace-tab-intent-store'
import { MAX_REMOTE_WORKSPACE_OBSERVATION_BYTES_PER_TARGET } from './remote-workspace-tab-observation-bounds'

const TARGET = 'target-a'
const WORKTREE_ID = 'repo-a::/remote/work'

function tab(id: string, layoutBytes: number): RemoteWorkspaceObservedTab {
  return {
    processIdentity: `process-${id}`,
    tab: {
      id,
      worktreePath: '/remote/work',
      ptyId: `pty-${id}`,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: Number(id.split('-').at(-1))
    },
    layout: {
      activeLeafId: 'leaf',
      buffersByLeafId: { leaf: 'x'.repeat(layoutBytes) },
      expandedLeafId: null,
      root: null
    }
  }
}

function observation(tabs: RemoteWorkspaceObservedTab[]): RemoteWorkspaceTabObservation {
  return {
    hydrated: true,
    rendererGeneration: 1,
    targetId: TARGET,
    worktrees: [
      {
        worktreeId: WORKTREE_ID,
        worktreeInstanceId: 'worktree-1',
        worktreePath: '/remote/work',
        tabs
      }
    ]
  }
}

function observeSequentialLayouts(
  store: RemoteWorkspaceTabIntentStore,
  start: number,
  end: number,
  layoutBytes: number
): void {
  const authority = { processId: 10, rendererGeneration: 1, senderId: 1 }
  for (let index = start; index < end; index += 1) {
    store.observe(authority, observation([tab(`tab-${index}`, layoutBytes)]))
  }
}

describe('remote workspace tab intent retention', () => {
  it('bounds aggregate sequential layouts proportionally and releases them on cleanup', () => {
    const authority = { processId: 10, rendererGeneration: 1, senderId: 1 }
    const proportional = new RemoteWorkspaceTabIntentStore()
    proportional.observe(authority, { ...observation([]), authoritative: true })
    observeSequentialLayouts(proportional, 0, 4, 8_192)
    expect(proportional.stateForTests(TARGET)).toEqual({ intents: 4, overflowed: false })
    observeSequentialLayouts(proportional, 4, 8, 8_192)
    expect(proportional.stateForTests(TARGET)).toEqual({ intents: 8, overflowed: false })

    const overflow = new RemoteWorkspaceTabIntentStore()
    overflow.observe(authority, { ...observation([]), authoritative: true })
    observeSequentialLayouts(
      overflow,
      0,
      8,
      Math.floor(MAX_REMOTE_WORKSPACE_OBSERVATION_BYTES_PER_TARGET / 4)
    )
    expect(overflow.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: true })

    overflow.forgetTarget(TARGET, authority)
    expect(overflow.stateForTests(TARGET)).toBeNull()
  })
})
