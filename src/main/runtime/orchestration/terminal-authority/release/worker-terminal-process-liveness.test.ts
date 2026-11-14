import { describe, expect, it } from 'vitest'
import { classifyWorkerTerminalProcessIncarnation } from './worker-terminal-process-liveness'

const minted = '22222222-2222-4222-8222-222222222222'

describe('worker terminal process liveness', () => {
  it('lets an owner prove a current fence exited, including a PTY id with colons', () => {
    const fence = `ssh:host:pty-1:${minted}`
    expect(
      classifyWorkerTerminalProcessIncarnation(
        fence,
        [{ id: 'ssh:host:pty-1', incarnationId: minted, cwd: '', title: '' }],
        true
      )
    ).toBe('live')
    expect(classifyWorkerTerminalProcessIncarnation(fence, [], true)).toBe('exited')
    expect(classifyWorkerTerminalProcessIncarnation(fence, [], false)).toBe('unverifiable')
  })

  it('never treats a legacy runtime fence as exited, even beside its live PTY', () => {
    const legacy = 'runtime_old:pty_worker:1'
    expect(
      classifyWorkerTerminalProcessIncarnation(
        legacy,
        [{ id: 'pty_worker', incarnationId: minted, cwd: '', title: '' }],
        true
      )
    ).toBe('unverifiable')
    expect(classifyWorkerTerminalProcessIncarnation(legacy, [], true)).toBe('unverifiable')
  })
})
