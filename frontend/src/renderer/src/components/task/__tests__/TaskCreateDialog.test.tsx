// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskCreateDialog } from '../TaskCreateDialog'

vi.mock('../../../store', () => ({
  useAppStore: Object.assign(
    vi.fn((selector) => selector({ settings: {} })),
    {
      getState: () => ({ settings: {} })
    }
  )
}))

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

describe('TaskCreateDialog', () => {
  const onCreated = vi.fn()
  const onCancel = vi.fn()

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('empty title → Create button disabled', () => {
    render(<TaskCreateDialog projectId="p1" onCreated={onCreated} onCancel={onCancel} />)
    expect(screen.getByTestId('task-create-submit')).toBeDisabled()
  })

  it('types title, clicks Create → calls task.create({title, projectId}), calls onCreated on success', async () => {
    mockRpc.mockResolvedValueOnce(undefined)
    render(<TaskCreateDialog projectId="p1" onCreated={onCreated} onCancel={onCancel} />)

    fireEvent.change(screen.getByTestId('task-create-title-input'), {
      target: { value: 'New Task' }
    })
    fireEvent.click(screen.getByTestId('task-create-submit'))

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'task.create', {
        title: 'New Task',
        projectId: 'p1'
      })
      expect(onCreated).toHaveBeenCalled()
    })
  })

  it('Enter key in title input submits like clicking Create', async () => {
    mockRpc.mockResolvedValueOnce(undefined)
    render(<TaskCreateDialog projectId="p1" onCreated={onCreated} onCancel={onCancel} />)

    const input = screen.getByTestId('task-create-title-input')
    fireEvent.change(input, { target: { value: 'Enter Task' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'task.create', {
        title: 'Enter Task',
        projectId: 'p1'
      })
    })
  })

  it('RPC error → toast.error shown, dialog does not auto-close (onCreated not called)', async () => {
    mockRpc.mockRejectedValueOnce(new Error('boom'))
    render(<TaskCreateDialog projectId="p1" onCreated={onCreated} onCancel={onCancel} />)

    fireEvent.change(screen.getByTestId('task-create-title-input'), {
      target: { value: 'Failing Task' }
    })
    fireEvent.click(screen.getByTestId('task-create-submit'))

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to create task: boom')
    })
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('clicking Cancel calls onCancel, no RPC called', () => {
    render(<TaskCreateDialog projectId="p1" onCreated={onCreated} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('task-create-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
