// Layout-owner build: main's start of a pane publishes whether it resumed the pane's agent, so the
// window that attaches can say so; nothing for a plain start, and nothing with the switch off.
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
const PANE_KEY = `${PANE.tabId}:${PANE.leafId}`

/** A windowless host whose pane recorded a sleeping agent, and whose spawn reports `outcome`. */
function resumablePaneRuntime(outcome: PaneResumeOutcome | undefined, recorded = true) {
  const fixture = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal(
      recorded
        ? {
            sleepingAgentSessionsByPaneKey: {
              [PANE_KEY]: {
                paneKey: PANE_KEY,
                tabId: PANE.tabId,
                worktreeId: TEST_WORKTREE_ID,
                agent: 'claude',
                providerSession: { key: 'session_id', id: 'provider-session-1' },
                prompt: 'do the thing',
                state: 'working',
                capturedAt: 1,
                updatedAt: 1,
                origin: 'worktree-sleep'
              }
            }
          }
        : {}
    )
  )
  const runtime = new OrcaRuntimeService(
    Object.assign(fixture.runtimeStore, {
      getWorkspaceSessionHostIds: (): ExecutionHostId[] => [LOCAL_EXECUTION_HOST_ID]
    })
  )
  // A paired desktop's layout stream: what main publishes is what it reads.
  const desktopStream = runtime.subscribeWorkspaceLayouts(() => {})
  // A daemon start keeps the session id it was asked for, and reports its resume before binding.
  const spawn = vi.fn(
    async (args: {
      sessionId?: string
      resumeProviderSession?: unknown
      onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void
    }) => {
      const id = args.sessionId ?? 'pty-started'
      if (outcome) {
        args.onResumeOutcome?.(id, outcome)
      }
      return { id }
    }
  )
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn, desktopStream, ...fixture }
}

/** The pane as main publishes it to a paired desktop. */
function publishedPane(runtime: InstanceType<typeof OrcaRuntimeService>) {
  const { snapshot, unsubscribe } = runtime.subscribeWorkspaceLayouts(() => {})
  unsubscribe()
  return snapshot
    .find((entry) => entry.key === TEST_WORKTREE_ID)
    ?.layout.tabs.flatMap((tab) => tab.terminal?.panes ?? [])
    .find((pane) => pane.leafId === HEADLESS_LEAF_ID)
}

describe("main's start of a pane publishes its resume outcome", () => {
  it.each(['restored', 'resume-unavailable'] as const)(
    'publishes %s on the pane bound to the terminal it started, switch-on only',
    async (outcome) => {
      const { runtime, spawn, getSession } = resumablePaneRuntime(outcome)

      await expect(runtime.ensureRestoredPaneStarted(PANE)).resolves.toMatchObject({
        id: 'persisted-pty'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ resumeProviderSession: expect.anything() })
      )
      const pane = publishedPane(runtime)
      expect(pane?.ptyId).toBe('persisted-pty')
      expect(pane?.resumeOutcome).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? outcome : undefined)
      // Live state only: the session main saves never holds it.
      expect(JSON.stringify(getSession())).not.toContain('resumeOutcome')
    }
  )

  it('publishes it for any create into the pane that wakes its record, not only a restore', async () => {
    // A window tab's start through main's create (PR-3a) names the wake itself.
    const { runtime } = resumablePaneRuntime('restored', false)

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: PANE.tabId,
      leafId: PANE.leafId,
      sessionId: 'persisted-pty',
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: 'provider-session-1' },
      resumesSleepingRecord: true
    })

    expect(publishedPane(runtime)?.ptyId).toBe('persisted-pty')
    expect(publishedPane(runtime)?.resumeOutcome).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? 'restored' : undefined
    )
  })

  it('publishes nothing for a start that resumed nothing', async () => {
    const { runtime } = resumablePaneRuntime(undefined, false)

    await runtime.ensureRestoredPaneStarted(PANE)

    expect(publishedPane(runtime)).toMatchObject({ ptyId: 'persisted-pty' })
    expect(publishedPane(runtime)?.resumeOutcome).toBeUndefined()
  })

  it('drops the outcome once the pane binds another terminal', async () => {
    const { runtime, getSession, setSession, desktopStream } = resumablePaneRuntime('restored')
    await runtime.ensureRestoredPaneStarted(PANE)
    expect(publishedPane(runtime)?.resumeOutcome).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? 'restored' : undefined
    )
    const session = getSession()
    const layout = session.terminalLayoutsByTabId[PANE.tabId]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [PANE.tabId]: {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [PANE.leafId]: 'pty-rebound' }
        }
      }
    })
    // The stream re-projects from the rebound session, as a write notification would make it.
    desktopStream.unsubscribe()

    expect(publishedPane(runtime)).toMatchObject({ ptyId: 'pty-rebound' })
    expect(publishedPane(runtime)?.resumeOutcome).toBeUndefined()
  })
})
