import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_SHELL_LISTENING_PROPERTY,
  MOBILE_WEB_SHELL_PENDING_PROPERTY,
  subscribeToMobileWebShellMessages
} from './native-shell-message-inbox'

describe('native shell message inbox', () => {
  it('drains native messages queued before the React listener mounts', () => {
    const target = createTarget(['init', 'connection'])
    const receive = vi.fn()

    const unsubscribe = subscribeToMobileWebShellMessages(target.window, receive)

    expect(receive.mock.calls).toEqual([['init'], ['connection']])
    expect(target.window[MOBILE_WEB_SHELL_PENDING_PROPERTY]).toEqual([])
    expect(target.window[MOBILE_WEB_SHELL_LISTENING_PROPERTY]).toBe(true)

    unsubscribe()
    expect(target.window[MOBILE_WEB_SHELL_LISTENING_PROPERTY]).toBe(false)
  })

  it('forwards later window messages and stops after cleanup', () => {
    const target = createTarget([])
    const receive = vi.fn()
    const unsubscribe = subscribeToMobileWebShellMessages(target.window, receive)

    target.dispatch('live')
    target.dispatch(42)
    target.dispatch('frame-spoof', {} as Window)
    unsubscribe()
    target.dispatch('stale')

    expect(receive).toHaveBeenCalledOnce()
    expect(receive).toHaveBeenCalledWith('live')
  })
})

function createTarget(pending: string[]): {
  window: Window & {
    [MOBILE_WEB_SHELL_LISTENING_PROPERTY]?: boolean
    [MOBILE_WEB_SHELL_PENDING_PROPERTY]?: string[]
  }
  dispatch(data: unknown, source?: MessageEventSource | null): void
} {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined
  const target = {
    [MOBILE_WEB_SHELL_PENDING_PROPERTY]: [...pending],
    addEventListener: vi.fn((_type: string, next: (event: MessageEvent<unknown>) => void) => {
      listener = next
    }),
    removeEventListener: vi.fn(() => {
      listener = undefined
    })
  } as unknown as Window & {
    [MOBILE_WEB_SHELL_LISTENING_PROPERTY]?: boolean
    [MOBILE_WEB_SHELL_PENDING_PROPERTY]?: string[]
  }
  return {
    window: target,
    dispatch(data, source = null) {
      listener?.({ data, source } as MessageEvent<unknown>)
    }
  }
}
