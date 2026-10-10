import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { sendBundleInstallProgress, sendSkillInstallProgress } from './skill-install-progress-ipc'

function event(destroyed = false): IpcMainInvokeEvent {
  return {
    sender: { isDestroyed: () => destroyed, send: vi.fn() }
  } as unknown as IpcMainInvokeEvent
}

describe('skill install progress IPC', () => {
  it('projects destination-owned bundle progress without paths or grants', () => {
    const target = event()
    sendBundleInstallProgress(target, {
      operationId: 'operation_1',
      skillId: 'alpha',
      skillName: 'alpha',
      skillIndex: 2,
      skillCount: 30
    })

    expect(target.sender.send).toHaveBeenCalledWith('skills:installProgress', {
      operationId: 'operation_1',
      phase: 'installing',
      currentSkill: { id: 'alpha', name: 'alpha', index: 2, total: 30 }
    })
  })

  it('does not publish after the invoking renderer is destroyed', () => {
    const target = event(true)
    sendSkillInstallProgress(target, { operationId: 'operation_1', phase: 'authorizing' })
    expect(target.sender.send).not.toHaveBeenCalled()
  })
})
