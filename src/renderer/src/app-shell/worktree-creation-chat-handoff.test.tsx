// @vitest-environment happy-dom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { executeWorktreeCreation } from '@/lib/worktree-creation-flow-execute'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { useQuickSubmitAction } from '@/hooks/composer-state/quick-submit-action'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerNativeChatPane } from '@/components/native-chat/native-chat-composer-mount'
import { AppWorkspaceShell } from './AppWorkspaceShell'
import { useAppChromeLayout } from './use-app-chrome-layout'
import { useFloatingWorkspacePanel } from './use-floating-workspace-panel'

const host = vi.hoisted(() => ({ createSupport: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn((_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? host.createSupport() : new Promise(() => undefined)
  )
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

// Keep the actual shell, pending chat and creation flow; unrelated chrome and heavy pane contents are boundaries.
vi.mock('../components/Sidebar', () => ({ default: () => null }))
vi.mock('../components/right-sidebar', () => ({
  default: () => <aside aria-label="Workspace tools" />
}))
vi.mock('./TitlebarLeftControls', () => ({ TitlebarLeftControls: () => null }))
vi.mock('./TitlebarMainStrip', () => ({
  TitlebarMainStrip: () => null,
  RightSidebarToggle: () => null
}))
vi.mock('@/components/native-chat/NativeChatComposer', () => ({
  NativeChatComposer: () => <textarea aria-label="Pending chat message" />
}))
vi.mock('../components/Terminal', () => ({
  default: function CreatedChatPane() {
    const chatTabId = useAppStore((s) =>
      Object.values(s.unifiedTabsByWorktree)
        .flat()
        .find((tab) => tab.contentType === 'agent-session')
    )?.id
    // Like the real chat pane, report actionable so handoff need not wait out its fallback.
    useEffect(
      () => (chatTabId ? registerNativeChatPane(chatTabId, () => true) : undefined),
      [chatTabId]
    )
    const hasChat = useAppStore((s) =>
      (s.unifiedTabsByWorktree[s.activeWorktreeId ?? ''] ?? []).some(
        (tab) => tab.contentType === 'agent-session'
      )
    )
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
    const hasTerminal = useAppStore(
      (s) => (s.tabsByWorktree[s.activeWorktreeId ?? ''] ?? []).length > 0
    )
    return hasChat ? (
      <div role="log" aria-label="Created chat" />
    ) : hasTerminal ? (
      <div role="log" aria-label="Workspace terminal">
        {activeWorktreeId}
      </div>
    ) : null
  }
}))

function WorkspaceShell(): React.JSX.Element {
  return (
    <AppWorkspaceShell
      layout={useAppChromeLayout()}
      floatingWorkspace={useFloatingWorkspacePanel()}
    />
  )
}

const expectedFolderWorkspaceId =
  process.platform === 'win32' ? 'repo-1::\\workspace\\feature' : 'repo-1::/workspace/feature'
const initialState = useAppStore.getState()
let main: TabsDrawnFromMain | undefined
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

describe('worktree creation chat handoff', () => {
  it('retains the visible workspace until ordinary local folder creation completes', async () => {
    const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
    const previous = { ...worktree, id: 'previous-workspace', path: '/workspace/previous' }
    seedEmptyActivatableWorktree(worktree, { extraWorktrees: [previous] })
    useAppStore.getState().createTab(previous.id)
    vi.spyOn(window.api.pty, 'listSessions').mockReturnValue(new Promise(() => {}))
    const checkout = Promise.withResolvers<{
      worktree: typeof worktree
      startupTerminal: { spawned: boolean }
    }>()
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, kind: 'folder' as const })),
      activeWorktreeId: previous.id,
      activeView: 'terminal',
      pendingWorktreeCreations: {},
      createWorktree: vi.fn(() => checkout.promise)
    }))
    main = await drawTabsFromMain(useAppStore)
    render(
      <TooltipProvider>
        <WorkspaceShell />
      </TooltipProvider>
    )
    const terminal = await screen.findByRole('log', { name: 'Workspace terminal' })
    expect(terminal.textContent).toBe('previous-workspace')

    act(() => {
      runBackgroundWorktreeCreation({
        repoId: worktree.repoId,
        executionHostId: 'local',
        worktreeCreateProgressMode: 'stepped',
        name: 'feature',
        setupDecision: 'skip',
        agent: null,
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      })
    })
    expect(screen.getByRole('log', { name: 'Workspace terminal' })).toBe(terminal)
    expect(terminal.textContent).toBe('previous-workspace')

    await act(async () => {
      checkout.resolve({ worktree, startupTerminal: { spawned: false } })
    })
    await waitFor(() =>
      expect(screen.getByRole('log', { name: 'Workspace terminal' }).textContent).toBe(
        expectedFolderWorkspaceId
      )
    )
  })

  it('opens a hidden linked creation from another page through composer re-entry and settlement', async () => {
    const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
    seedEmptyActivatableWorktree(worktree)
    const checkout = Promise.withResolvers<{ worktree: typeof worktree }>()
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, kind: 'folder' as const })),
      activeView: 'tasks',
      activeWorktreeId: null,
      pendingWorktreeCreations: {},
      createWorktree: vi.fn(() => checkout.promise)
    }))
    main = await drawTabsFromMain(useAppStore)
    act(() => {
      runBackgroundWorktreeCreation({
        repoId: worktree.repoId,
        executionHostId: 'local',
        worktreeCreateProgressMode: 'stepped',
        name: 'feature',
        linkedIssue: 42,
        setupDecision: 'skip',
        agent: null,
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      })
    })
    const { result } = renderHook(() =>
      useQuickSubmitAction({
        effectiveLinkedPR: null,
        executeQuickCreation: vi.fn(),
        fallbackCreatureName: 'feature',
        isProjectGroupTarget: false,
        isSubmissionCancelled: () => false,
        linkedPR: undefined,
        linkedWorkItem: null,
        name: 'feature',
        parsedLinkedIssueNumber: 42,
        repoId: worktree.repoId,
        requiresExplicitSetupChoice: false,
        resolvePendingSmartGitHubSubmit: async () => ({ kind: 'none' }),
        selectedRepo: useAppStore.getState().repos[0],
        selectedRepoRequiresConnection: false,
        selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
        setCreateError: vi.fn(),
        setCreating: vi.fn(),
        setupDecision: 'skip',
        showProjectRequiredError: vi.fn(),
        sourceIntentBlocksCreate: false,
        sparseError: null,
        submitFolderTarget: vi.fn(),
        taskSourceContext: null,
        telemetrySource: undefined
      })
    )
    await act(async () => {
      await result.current.submitQuick(null)
    })
    render(
      <TooltipProvider>
        <WorkspaceShell />
      </TooltipProvider>
    )
    await act(async () => {
      checkout.resolve({ worktree })
    })
    await waitFor(() =>
      expect(screen.getByRole('log', { name: 'Workspace terminal' }).textContent).toBe(
        expectedFolderWorkspaceId
      )
    )
  })

  it.each([true, false])(
    'keeps the pending chat and sidebar mounted through handoff (sidebar open: %s)',
    async (rightSidebarOpen) => {
      await import('../components/worktree-creation/PendingNativeChatCreation')
      const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
      seedEmptyActivatableWorktree(worktree)
      const request: WorktreeCreationRequest = {
        repoId: worktree.repoId,
        name: 'feature',
        setupDecision: 'skip',
        agent: 'codex',
        agentLaunchRoute: 'structured-native-chat',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }
      const checkout = Promise.withResolvers<{ worktree: typeof worktree }>()
      const admission = Promise.withResolvers<{ supported: boolean }>()
      host.createSupport.mockReturnValue(admission.promise)
      useAppStore.setState({
        activeWorktreeId: null,
        activeView: 'terminal',
        sidebarOpen: true,
        rightSidebarOpen,
        createWorktree: vi.fn(() => checkout.promise),
        pendingWorktreeCreations: {}
      })
      useAppStore.getState().beginPendingWorktreeCreation({
        creationId: 'creation-chat',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      })

      main = await drawTabsFromMain(useAppStore)
      render(
        <TooltipProvider>
          <WorkspaceShell />
        </TooltipProvider>
      )
      const composer = await screen.findByRole('textbox', { name: 'Pending chat message' })
      const sidebar = screen.getByRole('complementary', { name: 'Workspace tools' })
      expect(screen.getByRole('button', { name: 'Cancel worktree creation' })).toBeTruthy()

      let completion: Promise<void> = Promise.resolve()
      act(() => {
        completion = executeWorktreeCreation('creation-chat', request)
      })
      expect(screen.getByRole('textbox', { name: 'Pending chat message' })).toBe(composer)

      await act(async () => {
        checkout.resolve({ worktree })
      })
      await waitFor(() => expect(host.createSupport).toHaveBeenCalled())
      expect(screen.getByRole('textbox', { name: 'Pending chat message' })).toBe(composer)
      expect(screen.queryByRole('log', { name: 'Created chat' })).toBeNull()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        layoutApplyTestTransport.answerWith((command) =>
          command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
        )
      }
      await act(async () => {
        admission.resolve({ supported: true })
      })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBe(1))
        expect(screen.getByRole('textbox', { name: 'Pending chat message' })).toBe(composer)
        expect(screen.queryByRole('log', { name: 'Created chat' })).toBeNull()
        await act(async () => {
          layoutApplyTestTransport.answerWith('apply')
          layoutApplyTestTransport.answerPending()
        })
      }
      await act(async () => {
        await completion
      })
      expect(await screen.findByRole('log', { name: 'Created chat' })).toBeTruthy()
      expect(screen.queryByRole('textbox', { name: 'Pending chat message' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Cancel worktree creation' })).toBeNull()
      expect(screen.getByRole('complementary', { name: 'Workspace tools' })).toBe(sidebar)
    }
  )
})
