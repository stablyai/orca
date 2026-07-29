import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, sendMock, getAllWindowsMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  sendMock: vi.fn(),
  getAllWindowsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  }
}))

import { registerAuditedWorkflowDevTransitionHandlers } from './audited-workflow-dev-transitions'
import { AuditedTaskRepository } from '../audited-workflow/audited-task-repository'
import {
  selectTask,
  setAuditedTaskRepositoryForTests
} from '../audited-workflow/audited-task-service'

describe('registerAuditedWorkflowDevTransitionHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    sendMock.mockReset()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    setAuditedTaskRepositoryForTests(new AuditedTaskRepository(':memory:'))
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
  })

  function getHandler() {
    registerAuditedWorkflowDevTransitionHandlers()
    const call = handleMock.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'auditedWorkflow:devTransition'
    )
    if (!call) {
      throw new Error('auditedWorkflow:devTransition handler was not registered')
    }
    return call[1] as (_event: unknown, args?: unknown) => Promise<unknown>
  }

  it('applies a legal transition and broadcasts the updated projection', async () => {
    const { taskId } = selectTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Dev transition test',
      spec: { title: 'Dev transition test', description: '' },
      source: 'custom',
      risk: 'low'
    })

    const window = { isDestroyed: () => false, webContents: { send: sendMock } }
    getAllWindowsMock.mockReturnValue([window])

    const handler = getHandler()
    const result = await handler(null, { taskId, command: 'triage' })

    expect(result).toEqual({ applied: true })
    expect(sendMock).toHaveBeenCalledWith(
      'auditedWorkflow:taskChanged',
      expect.objectContaining({ taskId, state: 'triaging' })
    )
  })

  it('rejects an illegal transition without broadcasting', async () => {
    const { taskId } = selectTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Illegal transition test',
      spec: { title: 'Illegal transition test', description: '' },
      source: 'custom',
      risk: 'low'
    })

    const handler = getHandler()
    const result = await handler(null, { taskId, command: 'implement' })

    expect(result).toEqual({ applied: false, reasonCode: 'illegal_transition' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown command via Zod validation', () => {
    // Why: this handler is synchronous — Zod's .parse() throws directly.
    const handler = getHandler()
    expect(() => handler(null, { taskId: 'x', command: 'notARealCommand' })).toThrow()
  })

  it('rejects malformed params (missing taskId)', () => {
    const handler = getHandler()
    expect(() => handler(null, { command: 'triage' })).toThrow()
  })
})
