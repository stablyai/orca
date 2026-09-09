// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { TaskDetail } from '../TaskDetail'
import { useTask } from '../../../hooks/useTask'
import { registerTraceSink, type TraceEvent } from '../../../../../shared/trace'
import type { OrcaTask } from '../../../../../shared/task-types'
import type { OrcaUser } from '../../../store/slices/auth'

// Real Radix Tabs doesn't reliably switch active tab under fireEvent.click in happy-dom
// (same workaround used elsewhere in this codebase, e.g. CreateProjectDialog.test.tsx) —
// a minimal controlled mock instead, so TabsContent visibility actually follows value.
vi.mock('../../ui/tabs', () => {
  const TabsCtx = createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => {}
  })
  const Tabs = (p: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => {
    const ctxValue = useMemo(
      () => ({ value: p.value, onValueChange: p.onValueChange }),
      [p.value, p.onValueChange]
    )
    return (
      <TabsCtx.Provider value={ctxValue}>
        <div>{p.children}</div>
      </TabsCtx.Provider>
    )
  }
  const TabsList = (p: { children: ReactNode }) => <div>{p.children}</div>
  const TabsTrigger = (p: { value: string; children: ReactNode; 'data-testid'?: string }) => {
    const ctx = useContext(TabsCtx)
    return (
      <button
        type="button"
        data-testid={p['data-testid']}
        onClick={() => ctx.onValueChange(p.value)}
      >
        {p.children}
      </button>
    )
  }
  const TabsContent = (p: { value: string; children: ReactNode }) => {
    const ctx = useContext(TabsCtx)
    return ctx.value === p.value ? <div>{p.children}</div> : null
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent }
})

// Mock useAppStore for activeTaskId and settings
vi.mock('../../../store', () => ({
  useAppStore: Object.assign(
    vi.fn((selector) => selector({ activeTaskId: 't1', settings: {} })),
    { getState: () => ({ settings: {} }) }
  )
}))

// Mock useTask
vi.mock('../../../hooks/useTask', () => ({
  useTask: vi.fn()
}))

// Mock useAuthUser (FE-TASK-004's permission-gated Run button needs a current user id)
vi.mock('../../../hooks/useAuthSession', () => ({
  useAuthUser: vi.fn().mockReturnValue(null)
}))
import { useAuthUser } from '../../../hooks/useAuthSession'

// Mock TaskGrantModal — its own behavior is covered by TaskGrantModal.test.tsx
vi.mock('../TaskGrantModal', () => ({
  TaskGrantModal: ({ taskId }: { taskId: string }) => (
    <div data-testid="mock-task-grant-modal">{taskId}</div>
  )
}))

// Mock useTaskActivity — its own polling behavior is covered by useTaskActivity.test.ts
vi.mock('../../../hooks/useTaskActivity', () => ({
  useTaskActivity: vi.fn().mockReturnValue({ task: null, isLive: false })
}))
import { useTaskActivity } from '../../../hooks/useTaskActivity'

// Mock useWorkspace (real one requires <WorkspaceProvider>)
vi.mock('../../../context/WorkspaceContext', () => ({
  useWorkspace: vi.fn().mockReturnValue({
    project: { id: 'p1' },
    currentWorktree: { id: 'wt-1', path: '/repo/p1', branch: 'main', isMain: true }
  })
}))

// Mock RPC
vi.mock('../../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn().mockReturnValue('mock-target')
}))
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'
const mockRpc = vi.mocked(callRuntimeRpc)

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))
import { toast } from 'sonner'
const mockToast = vi.mocked(toast)

function makeUseTaskReturn(
  overrides: Partial<ReturnType<typeof useTask>> = {}
): ReturnType<typeof useTask> {
  return {
    task: undefined,
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    aiDecompose: vi.fn(),
    acceptSubtasks: vi.fn(),
    ...overrides
  }
}

function captureTraceEvents(): { events: TraceEvent[]; stop: () => void } {
  const events: TraceEvent[] = []
  const unregister = registerTraceSink((e) => events.push(e))
  return { events, stop: unregister }
}

describe('TaskDetail', () => {
  const updateTask = vi.fn()

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.mocked(useTask).mockReturnValue(
      makeUseTaskReturn({
        task: {
          id: 't1',
          title: 'My Task',
          status: 'todo',
          priority: 'high',
          projectId: 'p1'
        } as unknown as OrcaTask,
        updateTask
      })
    )
    vi.mocked(useAuthUser).mockReturnValue(null)
    vi.mocked(useTaskActivity).mockReturnValue({ task: null, isLive: false })
    mockRpc.mockResolvedValue([]) // task.getDependencies returns a flat { task, edgeType }[]
  })

  it('null task → renders empty state', () => {
    vi.mocked(useTask).mockReturnValue(makeUseTaskReturn({ task: undefined, updateTask }))
    render(<TaskDetail />)
    expect(screen.getByText('Select a task')).toBeInTheDocument()
  })

  it('renders task title in input', () => {
    render(<TaskDetail />)
    expect(screen.getByTestId('task-title-input')).toHaveValue('My Task')
  })

  it('Execute with Agent button calls task.execute with taskId/projectId/worktreePath + traceId', async () => {
    render(<TaskDetail />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        'mock-target',
        'task.execute',
        expect.objectContaining({
          taskId: 't1',
          projectId: 'p1',
          worktreePath: '/repo/p1',
          traceId: expect.any(String)
        })
      )
    })
  })

  it('click run-agent-btn → Tracers.uiTaskGraphExecuteFlow.start({taskId, entryPoint: "task-detail"}), traceId forwarded to RPC', async () => {
    const { events, stop } = captureTraceEvents()
    render(<TaskDetail />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'task.execute', expect.any(Object))
    })
    stop()

    const flowEvents = events.filter((e) => e.flow === 'ui:taskGraph.execute')
    const startEvent = flowEvents.find((e) => e.level === 'start')
    expect(startEvent?.fields.taskId).toBe('t1')
    expect(startEvent?.fields.entryPoint).toBe('task-detail')

    const runAgentCall = mockRpc.mock.calls.find((c) => c[1] === 'task.execute')
    expect((runAgentCall?.[2] as { traceId?: string } | undefined)?.traceId).toBe(startEvent?.id)
  })

  it('RPC success → span.ok({taskId}), toast.success shown', async () => {
    mockRpc.mockResolvedValueOnce([]) // task.getDependencies (mount)
    const { events, stop } = captureTraceEvents()
    render(<TaskDetail />)

    mockRpc.mockResolvedValueOnce(undefined) // task.execute
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Agent started for: My Task')
    })
    stop()

    const okEvent = events.find((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'ok')
    expect(okEvent?.fields.taskId).toBe('t1')
  })

  it('RPC error → span.fail(err, {taskId}), toast.error shown', async () => {
    const err = new Error('agent spawn failed')
    render(<TaskDetail />)

    mockRpc.mockRejectedValueOnce(err) // task.execute
    const { events, stop } = captureTraceEvents()
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to start agent: agent spawn failed')
    })
    stop()

    const failEvents = events.filter((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'fail')
    expect(failEvents).toHaveLength(1)
    expect(failEvents[0]?.fields.taskId).toBe('t1')
  })

  it('dependencies section renders blocked-by list', async () => {
    mockRpc.mockResolvedValueOnce([
      { task: { id: 'b1', title: 'Blocker 1' }, edgeType: 'depends_on' }
    ])
    render(<TaskDetail />)
    await waitFor(() => {
      expect(screen.getByText('Blocker 1')).toBeInTheDocument()
      expect(screen.getByText('← Blocked by:')).toBeInTheDocument()
    })
  })

  it("task.resolvePermission → effectiveLevel='user' → canManage=false → Run button not rendered", async () => {
    vi.mocked(useAuthUser).mockReturnValue({ id: 'me' } as unknown as OrcaUser)
    mockRpc.mockImplementation((_target, method) => {
      if (method === 'task.resolvePermission') {
        return Promise.resolve({ effectiveLevel: 'user' })
      }
      return Promise.resolve([]) // task.getDependencies
    })
    render(<TaskDetail />)
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'task.resolvePermission', {
        taskId: 't1',
        userId: 'me'
      })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('run-agent-btn')).not.toBeInTheDocument()
    })
  })

  it("task.resolvePermission → effectiveLevel='owner' → Run button renders normally", async () => {
    vi.mocked(useAuthUser).mockReturnValue({ id: 'me' } as unknown as OrcaUser)
    mockRpc.mockImplementation((_target, method) => {
      if (method === 'task.resolvePermission') {
        return Promise.resolve({ effectiveLevel: 'owner' })
      }
      return Promise.resolve([])
    })
    render(<TaskDetail />)
    await waitFor(() => {
      expect(screen.getByTestId('run-agent-btn')).toBeInTheDocument()
    })
  })

  it('Access tab renders TaskGrantModal with the current taskId', () => {
    render(<TaskDetail />)
    fireEvent.click(screen.getByText('Access'))
    expect(screen.getByTestId('mock-task-grant-modal')).toHaveTextContent('t1')
  })

  it("useTaskActivity's polled status renders via TaskStatusBadge (icon/label), not raw text", () => {
    vi.mocked(useTaskActivity).mockReturnValue({
      task: { id: 't1', status: 'in_progress' } as unknown as OrcaTask,
      isLive: false
    })
    render(<TaskDetail />)
    // task.status prop is 'todo' (useTask mock) — the badge must reflect the polled
    // 'in_progress' override, confirming TaskDetail prefers polledTask.status.
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('🔄')).toBeInTheDocument()
  })
})
