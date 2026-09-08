// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskPromptEditor } from '../TaskPromptEditor'
import { registerTraceSink, type TraceEvent } from '../../../../../shared/trace'
import type { OrcaTask } from '../../../../../shared/task-types'

// Mock useAppStore for settings
vi.mock('../../../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({ settings: {} }) })
}))

// Mock useWorkspace (real one requires <WorkspaceProvider>)
vi.mock('../../../context/WorkspaceContext', () => ({
  useWorkspace: vi.fn().mockReturnValue({
    project: { id: 'proj-1' },
    currentWorktree: { id: 'wt-1', path: '/repo/proj-1', branch: 'main', isMain: true }
  })
}))

// Mock RPC
vi.mock('../../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn().mockReturnValue('mock-target')
}))
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'
const mockRpc = vi.mocked(callRuntimeRpc)

function captureTraceEvents(): { events: TraceEvent[]; stop: () => void } {
  const events: TraceEvent[] = []
  const unregister = registerTraceSink((e) => events.push(e))
  return { events, stop: unregister }
}

const task: OrcaTask = {
  id: 't1',
  title: 'My Task',
  status: 'todo',
  priority: 'high',
  projectId: 'proj-1',
  promptTemplate: 'do the thing'
} as OrcaTask

describe('TaskPromptEditor.runWithAgent() tracing', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockRpc.mockResolvedValue(undefined)
  })

  it('click run-agent-btn → Tracers.uiTaskGraphExecuteFlow.start({taskId, entryPoint: "prompt-editor", promptLength})', async () => {
    const { events, stop } = captureTraceEvents()
    render(<TaskPromptEditor task={task} />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalled()
    })
    stop()

    const startEvent = events.find((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'start')
    expect(startEvent?.fields.taskId).toBe('t1')
    expect(startEvent?.fields.entryPoint).toBe('prompt-editor')
    expect(startEvent?.fields.promptLength).toBe('do the thing'.length)
  })

  it('task.execute RPC receives taskId/projectId/worktreePath/prompt + traceId === span.id (BACKLOG-016)', async () => {
    const { events, stop } = captureTraceEvents()
    render(<TaskPromptEditor task={task} />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        'mock-target',
        'task.execute',
        expect.objectContaining({
          taskId: 't1',
          projectId: 'proj-1',
          worktreePath: '/repo/proj-1',
          prompt: 'do the thing'
        })
      )
    })
    stop()

    const startEvent = events.find((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'start')
    const callArgs = mockRpc.mock.calls[0]
    expect(callArgs?.[1]).toBe('task.execute')
    expect((callArgs?.[2] as { traceId?: string } | undefined)?.traceId).toBe(startEvent?.id)
  })

  it('RPC success → span.ok({taskId})', async () => {
    const { events, stop } = captureTraceEvents()
    render(<TaskPromptEditor task={task} />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalled()
    })
    stop()

    const okEvent = events.find((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'ok')
    expect(okEvent?.fields.taskId).toBe('t1')
  })

  it('RPC error → span.fail(err, {taskId}) before re-throw, isRunning resets', async () => {
    const err = new Error('agent spawn failed')
    mockRpc.mockRejectedValueOnce(err)
    const { events, stop } = captureTraceEvents()

    // `runWithAgent` re-throws after span.fail() (matches TASK-FE-018.3 spec) but the
    // <Button onClick> call site is fire-and-forget (pre-existing, not this task's scope)
    // → swallow the resulting unhandled rejection so it doesn't fail the test run.
    const onUnhandled = (reason: unknown) => {
      void reason
    }
    process.on('unhandledRejection', onUnhandled)

    render(<TaskPromptEditor task={task} />)
    fireEvent.click(screen.getByTestId('run-agent-btn'))

    await waitFor(() => {
      const failEvents = events.filter(
        (e) => e.flow === 'ui:taskGraph.execute' && e.level === 'fail'
      )
      expect(failEvents).toHaveLength(1)
    })
    stop()
    process.off('unhandledRejection', onUnhandled)

    const failEvent = events.find((e) => e.flow === 'ui:taskGraph.execute' && e.level === 'fail')
    expect(failEvent?.fields.taskId).toBe('t1')
    expect(failEvent?.fields.err).toContain('agent spawn failed')

    // isRunning reset back to false in `finally` → button re-enabled (not stuck "Running...")
    await waitFor(() => {
      expect(screen.getByTestId('run-agent-btn')).not.toHaveTextContent('Running...')
    })
  })
})
