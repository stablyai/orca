import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { sendSkillInstallProgress } from './skill-install-progress-ipc'

function event(destroyed = false): IpcMainInvokeEvent {
  return {
    sender: { isDestroyed: () => destroyed, send: vi.fn() }
  } as unknown as IpcMainInvokeEvent
}

describe('skill install progress IPC', () => {
  it('does not publish after the invoking renderer is destroyed', () => {
    const target = event(true)
    sendSkillInstallProgress(target, { operationId: 'operation_1', phase: 'authorizing' })
    expect(target.sender.send).not.toHaveBeenCalled()
  })
})
