import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { terminateInteractiveLoginProcess } from './interactive-login-interruption'

function loginChild(pid = 4321): ChildProcess & EventEmitter {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid
  }) as unknown as ChildProcess & EventEmitter
}

describe('terminateInteractiveLoginProcess', () => {
  it('waits for both Windows tree termination and physical wrapper close', async () => {
    const child = loginChild()
    let finishTreeKill: (() => void) | undefined
    const killWindowsTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTreeKill = resolve
        })
    )
    let terminated = false

    const pending = terminateInteractiveLoginProcess(child, 'SIGTERM', {
      platform: 'win32',
      killWindowsTree
    }).then(() => {
      terminated = true
    })

    expect(killWindowsTree).toHaveBeenCalledWith(4321)
    child.emit('close', 1)
    await Promise.resolve()
    expect(terminated).toBe(false)

    finishTreeKill?.()
    await pending
    expect(child.kill).not.toHaveBeenCalled()
  })
})
