import { describe, expect, it, vi } from 'vitest'
import {
  getRendererRecoveryAction,
  planRendererRecoveryPrompt,
  RendererRecoveryPromptGate
} from './renderer-recovery-escalation'

describe('getRendererRecoveryAction', () => {
  it('recommends a relaunch when the renderer process never launched', () => {
    expect(getRendererRecoveryAction('launch-failed')).toBe('relaunch')
  })

  it('recommends a reload for renderer deaths a fresh document can fix', () => {
    expect(getRendererRecoveryAction('crashed')).toBe('reload')
    expect(getRendererRecoveryAction('oom')).toBe('reload')
    expect(getRendererRecoveryAction(undefined)).toBe('reload')
  })
})

describe('planRendererRecoveryPrompt', () => {
  it('offers Restart Orca first for a launch failure', () => {
    const plan = planRendererRecoveryPrompt({ action: 'relaunch', recentRecoveryCount: 0 })

    expect(plan.buttons).toEqual(['Restart Orca', 'Reload', 'Quit'])
    expect(plan.responses).toEqual(['relaunch', 'reload', 'quit'])
    expect(plan.responses[plan.defaultId]).toBe('relaunch')
    expect(plan.responses[plan.cancelId]).toBe('quit')
  })

  it('keeps the reload/quit prompt for crash loops and reports the attempt count', () => {
    const plan = planRendererRecoveryPrompt({ action: 'reload', recentRecoveryCount: 3 })

    expect(plan.buttons).toEqual(['Reload', 'Quit'])
    expect(plan.responses).toEqual(['reload', 'quit'])
    expect(plan.responses[plan.defaultId]).toBe('reload')
    expect(plan.responses[plan.cancelId]).toBe('quit')
    expect(plan.detail).toContain('3 times')
  })
})

describe('RendererRecoveryPromptGate', () => {
  it('drops a prompt requested while one is already on screen', async () => {
    const gate = new RendererRecoveryPromptGate()
    let resolveFirst: ((value: string) => void) | undefined
    const first = gate.show(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
    )
    const second = vi.fn(async () => 'second')

    expect(await gate.show(second)).toBeUndefined()
    expect(second).not.toHaveBeenCalled()

    resolveFirst?.('first')
    expect(await first).toBe('first')
  })

  it('prompts again once the user has answered the previous dialog', async () => {
    const gate = new RendererRecoveryPromptGate()

    expect(await gate.show(async () => 'first')).toBe('first')
    expect(await gate.show(async () => 'second')).toBe('second')
  })

  it('reopens after a rejected prompt so a dialog failure cannot wedge the gate shut', async () => {
    const gate = new RendererRecoveryPromptGate()

    await expect(
      gate.show(async () => {
        throw new Error('dialog failed')
      })
    ).rejects.toThrow('dialog failed')
    expect(await gate.show(async () => 'next')).toBe('next')
  })
})
