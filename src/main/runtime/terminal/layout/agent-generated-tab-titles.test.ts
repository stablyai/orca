// Main-owned agent titles use accepted hook status with a real Store and no window; batch one rename and frame per status group.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { WorkspaceLayoutStreamEvent } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { Store } from '../../../persistence/loading-store/store'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID as FOLDER,
  FIXTURE_GIT_WORKTREE_ID as GIT,
  openTopologyStore
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../../../shared/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const tabOf = (workspace: string) => `tab-${workspace.replace(/\W/g, '-')}`
const paneOf = (workspace: string) => makePaneKey(tabOf(workspace), LEAF)
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** One agent tab in each workspace, saved by the window before main's runtime starts. */
async function hostWith(
  workspaces: string[],
  options: { titles?: boolean; edit?: (session: WindowSession) => void } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-generated-titles-'))
  directories.push(directory)
  const store: Store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  store.updateSettings({ tabAutoGenerateTitle: options.titles ?? true })
  const session = new WindowSession(getDefaultWorkspaceSession())
  for (const workspace of workspaces) {
    session.addTab(workspace, tabOf(workspace), LEAF)
  }
  options.edit?.(session)
  store.setWorkspaceSession(session.snapshot(), 'local')
  await store.flushPendingOrThrowAsync()
  const runtime = new OrcaRuntimeService(store)
  const apply = vi.spyOn(runtime, 'applyLayoutCommand')
  const titleOf = (workspace: string) =>
    store.getWorkspaceSession().tabsByWorktree[workspace]?.[0]?.generatedTitle
  return { store, runtime, apply, titleOf }
}

function status(workspace: string, overrides: Partial<AgentStatusIpcPayload> = {}) {
  return {
    paneKey: paneOf(workspace),
    worktreeId: workspace,
    agentType: 'codex',
    state: 'working',
    prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
    receivedAt: 10,
    stateStartedAt: 10,
    connectionId: null,
    ...overrides
  } satisfies AgentStatusIpcPayload
}

const dispatch = (taskId: string, task: string) =>
  `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: ${taskId}

=== TASK ===
${task}`

describe('main titles agent tabs from its own hook status', () => {
  it('titles a headless host’s tab, which no window ever opened', async () => {
    const { runtime, titleOf } = await hostWith([GIT])

    runtime.recordHookStatusTitle(status(GIT))
    await runtime.hookStatusTitlesSettled()

    expect(titleOf(GIT)).toBe('Refactor the auth middleware to use JWT')
  })

  it('gives a batch’s titles of several workspaces in one rename and one frame', async () => {
    const { runtime, apply, titleOf } = await hostWith([GIT, FOLDER])
    const frames: WorkspaceLayoutStreamEvent[] = []
    runtime.subscribeWorkspaceLayouts((frame) => frames.push(frame))

    runtime.recordHookStatusTitle(status(GIT))
    runtime.recordHookStatusTitle(status(FOLDER, { prompt: 'Fix the login page' }))
    await runtime.hookStatusTitlesSettled()

    expect(apply.mock.calls.map(([command]) => command.type)).toEqual(['renameTabs'])
    expect(frames.filter((frame) => frame.type === 'records')).toHaveLength(1)
    expect(frames).toHaveLength(1)
    expect([titleOf(GIT), titleOf(FOLDER)]).toEqual([
      'Refactor the auth middleware to use JWT',
      'Fix the login page'
    ])
  })

  it('gives nothing with the setting off', async () => {
    const { runtime, apply, titleOf } = await hostWith([GIT], {
      titles: false
    })

    runtime.recordHookStatusTitle(status(GIT))
    await runtime.hookStatusTitlesSettled()

    expect(apply).not.toHaveBeenCalled()
    expect(titleOf(GIT)).toBeUndefined()
  })

  it('leaves a renamed tab and a quick command’s tab untitled', async () => {
    const { runtime, apply, titleOf } = await hostWith([GIT, FOLDER], {
      edit: (session) => {
        const [git] = session.session.tabsByWorktree[GIT]!
        const [folder] = session.session.tabsByWorktree[FOLDER]!
        session.session.tabsByWorktree[GIT] = [{ ...git!, customTitle: 'Status tests' }]
        session.session.tabsByWorktree[FOLDER] = [{ ...folder!, quickCommandLabel: 'Run tests' }]
      }
    })

    runtime.recordHookStatusTitle(status(GIT))
    runtime.recordHookStatusTitle(status(FOLDER))
    await runtime.hookStatusTitlesSettled()

    expect(apply).not.toHaveBeenCalled()
    expect([titleOf(GIT), titleOf(FOLDER)]).toEqual([undefined, undefined])
  })

  it('has the titles in the first snapshot a window that starts after them reads', async () => {
    const { runtime } = await hostWith([GIT])

    // Statuses main accepted at launch, before the window subscribes for its first frame.
    runtime.recordHookStatusTitle(status(GIT))
    await runtime.hookStatusTitlesSettled()
    const { snapshot } = runtime.subscribeWorkspaceLayouts(() => {})

    const tab = snapshot.find((entry) => entry.key === GIT)?.layout.tabs[0]
    expect(tab?.generatedTitle).toBe('Refactor the auth middleware to use JWT')
  })
})

// Main's twins of agent-generated-tab-title.test.ts, which pins the window's own titles.
describe('main keeps the window’s generated-title rules', () => {
  async function titled(
    statuses: AgentStatusIpcPayload[][],
    /** Main's dispatch labels; a list gives each read its own, the last one kept. */
    labels:
      | Record<string, AgentStatusOrchestrationContext>[]
      | Record<string, AgentStatusOrchestrationContext> = {}
  ) {
    const host = await hostWith([GIT])
    const reads = [labels].flat()
    const read = vi.spyOn(host.runtime['agentOrchestrationProjection'], 'buildByPaneKey')
    read.mockReturnValue(reads.at(-1))
    for (const each of reads.slice(0, -1)) {
      read.mockReturnValueOnce(each)
    }
    for (const batch of statuses) {
      for (const row of batch) {
        host.runtime.recordHookStatusTitle(row)
      }
      await host.runtime.hookStatusTitlesSettled()
    }
    return host
  }
  const labelsOf = (taskId: string, displayName: string) => ({
    [paneOf(GIT)]: {
      taskId,
      dispatchId: `ctx-${taskId}`,
      taskTitle: displayName,
      displayName
    }
  })

  it('keeps the first prompt’s title', async () => {
    const { titleOf } = await titled([
      [status(GIT)],
      [status(GIT, { prompt: 'Replace this with a later task name' })]
    ])
    expect(titleOf(GIT)).toBe('Refactor the auth middleware to use JWT')
  })

  it('titles a dispatch from its task, not its preamble', async () => {
    const { titleOf } = await titled([
      [
        status(GIT, {
          prompt: dispatch('task-1', 'Implement the detailed worker instructions')
        })
      ]
    ])
    expect(titleOf(GIT)).toBe('Implement the detailed worker')
  })

  it('replaces a dispatch’s preamble title once main has its labels', async () => {
    const prompt = dispatch('task-1', 'Implement the detailed worker instructions')
    const host = await titled(
      [[status(GIT, { prompt })]],
      [{}, labelsOf('task-1', 'Better worker label')]
    )
    expect(host.titleOf(GIT)).toBe('Implement the detailed worker')

    host.runtime.recordHookStatusTitle(status(GIT, { prompt, state: 'done' }))
    await host.runtime.hookStatusTitlesSettled()
    expect(host.titleOf(GIT)).toBe('Better worker label')
  })

  it('keeps a dispatch label when a later non-dispatch prompt comes', async () => {
    const { titleOf } = await titled(
      [
        [
          status(GIT, {
            prompt: dispatch('task-1', 'Implement the worker instructions')
          })
        ],
        [
          status(GIT, {
            prompt: 'Refactor the auth middleware to use JWT tokens'
          })
        ]
      ],
      labelsOf('task-1', 'Better worker label')
    )
    expect(titleOf(GIT)).toBe('Better worker label')
  })

  it('titles a later non-dispatch prompt while sticky labels remain but no title exists', async () => {
    const { titleOf } = await titled(
      [
        [
          status(GIT, {
            orchestration: labelsOf('task-1', 'Stale worker label')[paneOf(GIT)]
          })
        ]
      ],
      labelsOf('task-1', 'Stale worker label')
    )
    expect(titleOf(GIT)).toBe('Refactor the auth middleware to use JWT')
  })

  it('does not re-pin task A’s label onto a later dispatch of task B', async () => {
    const { titleOf } = await titled(
      [
        [
          status(GIT, {
            prompt: dispatch('task-a', 'Implement task A worker instructions')
          })
        ],
        [
          status(GIT, {
            prompt: dispatch('task-b', 'Implement task B worker instructions')
          })
        ]
      ],
      labelsOf('task-a', 'Worker A label')
    )
    expect(titleOf(GIT)).toBe('Implement task B worker instructions')
  })

  it('titles a paste-sized prompt from its start', async () => {
    const prompt = `Fix the flaky status tests ${'large pasted text '.repeat(5000)}`
    const { titleOf } = await titled([[status(GIT, { prompt })]])
    expect(titleOf(GIT)).toBe('Fix the flaky status tests large pasted')
  })

  it('keeps a title given in the same batch, as the window’s batch does', async () => {
    const { titleOf } = await titled([
      [status(GIT), status(GIT, { prompt: 'Replace this with a later task name' })]
    ])
    expect(titleOf(GIT)).toBe('Refactor the auth middleware to use JWT')
  })
})
