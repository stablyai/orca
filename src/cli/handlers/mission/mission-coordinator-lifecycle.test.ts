import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../../runtime-client'
import { manageMissionCoordinator } from './mission-coordinator-lifecycle'

afterEach(() => vi.restoreAllMocks())

describe('Mission interruption ownership', () => {
  it.each([true, false])('retains an unsettled Run coordinator, owned=%s', async (owned) => {
    const before = process.listeners('SIGINT')
    const call = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const lifecycle = manageMissionCoordinator({ call } as unknown as RuntimeClient, {
      handle: 'term_scope',
      owned
    })
    try {
      lifecycle.beforeRun()
      const interrupt = process.listeners('SIGINT').find((listener) => !before.includes(listener))!
      interrupt('SIGINT')
      interrupt('SIGINT')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130))
      expect(call).not.toHaveBeenCalled()
      expect(() => lifecycle.beforeRun()).toThrow('Mission interrupted')
      if (owned) {
        expect(console.error).toHaveBeenCalledTimes(1)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('term_scope'))
      }
    } finally {
      lifecycle.dispose()
    }
    expect(process.listeners('SIGINT')).toEqual(before)
  })

  it('never closes a caller-owned anchor on a pre-Run interruption', async () => {
    const before = process.listeners('SIGINT')
    const call = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const lifecycle = manageMissionCoordinator({ call } as unknown as RuntimeClient, {
      handle: 'term_user',
      owned: false
    })
    try {
      process.listeners('SIGINT').find((listener) => !before.includes(listener))!('SIGINT')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130))
      expect(call).not.toHaveBeenCalled()
    } finally {
      lifecycle.dispose()
    }
  })
})
