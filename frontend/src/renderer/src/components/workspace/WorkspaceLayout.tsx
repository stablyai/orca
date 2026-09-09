// WorkspaceLayout.tsx — 3-panel resizable workspace shell (TDD-FE-12)
// TASK-FE-003: Upgraded with ResizablePanelGroup + status bar + terminal toggle
import { lazy, Suspense, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useWorkspace } from '../../context/WorkspaceContext'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { OfflineBanner } from './OfflineBanner'
import { NoProjectSelected } from './NoProjectSelected'
import { WorkspaceSkeletonLoader } from './WorkspaceSkeletonLoader'
import { WorkspaceTerminalPanel } from './WorkspaceTerminalPanel'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable'

// Lazy loaded panels (heavy components)
const ExplorerPanel = lazy(() =>
  import('./ExplorerPanel').then((m) => ({ default: m.ExplorerPanel }))
)
const GitPanel = lazy(() => import('./git/GitPanel').then((m) => ({ default: m.GitPanel })))
const TaskGraphPanel = lazy(() =>
  import('../task/TaskGraphPanel').then((m) => ({ default: m.TaskGraphPanel }))
)
const WorkflowMonitor = lazy(() =>
  import('../workflow/WorkflowMonitor').then((m) => ({ default: m.WorkflowMonitor }))
)
const WorkflowBuilder = lazy(() =>
  import('../workflow/WorkflowBuilder').then((m) => ({ default: m.WorkflowBuilder }))
)
const WorkflowLibrary = lazy(() =>
  import('../workflow/WorkflowLibrary').then((m) => ({ default: m.WorkflowLibrary }))
)
const AgentPanel = lazy(() => import('./AgentPanel').then((m) => ({ default: m.AgentPanel })))
// Why: reuse the main app's SSH/remote-host status segment (already lazy
// there too) instead of a new ServerStatusBar — doc §4 step 6.
const SshStatusSegment = lazy(() =>
  import('../status-bar/SshStatusSegment').then((m) => ({ default: m.SshStatusSegment }))
)

type WorkspaceTab = 'git' | 'tasks' | 'workflows' | 'agent'

// Why: mirrors NoProjectSelected's style for the tab's own empty state —
// Agent/terminal need a worktree, which Workspace doesn't have yet until the
// sidebar selection syncs in (WorktreeList -> setCurrentWorktree).
function NoWorktreeSelected() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground"
      data-testid="no-worktree-selected"
    >
      <GitBranch size={48} className="opacity-30" />
      <p className="text-lg font-medium">No worktree selected</p>
      <p className="text-sm opacity-70">Select a worktree from the sidebar to continue</p>
    </div>
  )
}

export function WorkspaceLayout() {
  const { project, isOffline, isInitializing, switchProject, currentWorktree } = useWorkspace()
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('git')
  const [rightPanelVisible, setRightPanel] = useState(true)
  const [terminalVisible, setTerminalVisible] = useState(false)
  const [workflowView, setWorkflowView] = useState<'monitor' | 'builder' | 'library'>('monitor')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined)

  if (!project) {
    return <NoProjectSelected />
  }
  if (isInitializing) {
    return <WorkspaceSkeletonLoader />
  }

  return (
    <div className="workspace-layout flex flex-col h-full" data-testid="workspace-layout">
      {isOffline && (
        <OfflineBanner
          message="Dev server unreachable — read-only mode"
          onRetry={() => switchProject(project.id)}
        />
      )}

      <WorkspaceTabBar activeTab={activeTab} onTabChange={setActiveTab} />

      <ResizablePanelGroup orientation="horizontal" className="flex-1 overflow-hidden">
        {/* Left: File Explorer (always visible) */}
        {/* Why string sizes, not numbers: react-resizable-panels v4 interprets a bare number as
            PIXELS, not percent (only unitless strings mean percent) — passing {20} rendered a
            20px-wide Explorer instead of 20% of the panel group. */}
        <ResizablePanel defaultSize="20" minSize="15" maxSize="35" data-testid="panel-explorer">
          <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading...</div>}>
            <ExplorerPanel />
          </Suspense>
        </ResizablePanel>

        <ResizableHandle />

        {/* Center: Tab content */}
        <ResizablePanel defaultSize={rightPanelVisible ? '50' : '80'} data-testid="panel-center">
          <Suspense fallback={<WorkspaceSkeletonLoader />}>
            {/* Why: mirrors the 'agent' branch below — CR-PW-001, GitPanel used to render even
                with no worktree selected and silently fall back to a misleading "(no branch)". */}
            {activeTab === 'git' && (currentWorktree ? <GitPanel /> : <NoWorktreeSelected />)}
            {activeTab === 'tasks' && <TaskGraphPanel projectId={project.id} />}
            {activeTab === 'workflows' &&
              (workflowView === 'library' ? (
                <WorkflowLibrary
                  onUseTemplate={(id) => {
                    setSelectedTemplateId(id)
                    setWorkflowView('builder')
                  }}
                />
              ) : workflowView === 'builder' ? (
                <WorkflowBuilder
                  templateId={selectedTemplateId}
                  projectId={project.id}
                  onSave={() => setWorkflowView('monitor')}
                />
              ) : (
                <WorkflowMonitor
                  projectId={project.id}
                  onNewWorkflow={() => {
                    setSelectedTemplateId(undefined)
                    setWorkflowView('builder')
                  }}
                  onOpenLibrary={() => setWorkflowView('library')}
                />
              ))}
            {activeTab === 'agent' &&
              (currentWorktree ? (
                <AgentPanel worktreeId={currentWorktree.id} />
              ) : (
                <NoWorktreeSelected />
              ))}
          </Suspense>
        </ResizablePanel>

        {/* Right: collapsible sidebar */}
        {rightPanelVisible && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="30" minSize="20" data-testid="panel-right">
              <div className="workspace-right h-full border-l bg-muted/30 overflow-y-auto p-3 text-xs text-muted-foreground">
                {activeTab === 'git' && <span>Git details</span>}
                {activeTab === 'tasks' && <span>Task detail</span>}
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      {/* Bottom: terminal (collapsible) — reuses the app's terminal-pane/PTY
          infra via WorkspaceTerminalPanel, not a new PTY stack (doc §4 step 5). */}
      {terminalVisible && (
        <div
          className="workspace-terminal border-t h-48 overflow-auto"
          data-testid="terminal-panel"
        >
          {currentWorktree ? (
            <WorkspaceTerminalPanel worktreeId={currentWorktree.id} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a worktree to open a terminal
            </div>
          )}
        </div>
      )}

      {/* Status bar */}
      <div
        className="workspace-statusbar flex items-center gap-2 px-3 py-1 border-t text-xs bg-muted/50"
        data-testid="status-bar"
      >
        <button
          onClick={() => setTerminalVisible((v) => !v)}
          className="hover:text-foreground text-muted-foreground"
          data-testid="toggle-terminal"
        >
          {terminalVisible ? 'Hide Terminal' : 'Show Terminal'}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Suspense fallback={null}>
            <SshStatusSegment compact iconOnly={false} />
          </Suspense>
          <button
            onClick={() => setRightPanel((v) => !v)}
            className="hover:text-foreground text-muted-foreground"
            data-testid="toggle-right-panel"
          >
            {rightPanelVisible ? 'Hide Panel' : 'Show Panel'}
          </button>
        </div>
      </div>
    </div>
  )
}
