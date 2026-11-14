// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'

import { runBackgroundWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-flow'

import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'

import { TooltipProvider } from '@/components/ui/tooltip'
import { registerNativeChatPane } from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import { AppWorkspaceShell } from './AppWorkspaceShell'
import { useAppChromeLayout } from './use-app-chrome-layout'
import { useFloatingWorkspacePanel } from './use-floating-workspace-panel'

const host = vi.hoisted(() => ({ createSupport: vi.fn() }))
vi.mock('../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn((_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? host.createSupport() : new Promise(() => undefined)
  )
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

// Keep the actual shell, pending chat and creation flow; unrelated chrome and heavy pane contents are boundaries.
vi.mock('../components/Sidebar', () => ({ default: () => null }))
vi.mock('../components/right-sidebar/RightSidebar', () => ({
  default: () => <aside aria-label="Workspace tools" />
}))
vi.mock('./TitlebarLeftControls', () => ({ TitlebarLeftControls: () => null }))
vi.mock('./TitlebarMainStrip', () => ({
  TitlebarMainStrip: () => null,
  RightSidebarToggle: () => null
}))
vi.mock('@/components/native-chat/composer/NativeChatComposer', () => ({
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
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const initialState = useAppStore.getState()
let main: TabsDrawnFromMain | undefined
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('worktree creation chat handoff', () => {
  it('retains the visible workspace until ordinary local folder creation completes', async () => {
    const worktree = { ...makeCreatedAgentWorktree(), hostId: 'local' as const }
    const previous = { ...worktree, id: 'previous-workspace', path: '/workspace/previous' }
    seedEmptyActivatableWorktree(worktree, { extraWorktrees: [previous] })
    useAppStore.getState().createTab(previous.id)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: { call: vi.fn() },
        pty: { listSessions: () => new Promise(() => {}) }
      }
    })
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
})
