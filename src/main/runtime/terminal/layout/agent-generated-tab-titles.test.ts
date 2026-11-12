// Main-owned agent titles use accepted hook status with a real Store and no window; batch one rename and frame per status group.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

import type { Store } from '../../../persistence/loading-store/store'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
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

describe('main titles agent tabs from its own hook status', () => {
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
