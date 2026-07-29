import { describe, expect, it, vi } from 'vitest'
import { subscribeSshPtyNotifications } from './ssh-pty-notification-routing'

type MockMux = {
  onNotification: ReturnType<typeof vi.fn>
}

function createSubscription() {
  const mux: MockMux = {
    onNotification: vi.fn()
  }
  const dataListeners = new Set<(payload: { id: string; data: string }) => void>()
  const replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  const livePtyIds = new Set<string>()
  const recordExit = vi.fn()
  const toAppPtyId = vi.fn((id: string) => `ssh:conn@@${id}`)

  subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId,
    dataListeners: dataListeners as never,
    replayListeners: replayListeners as never,
    exitListeners: exitListeners as never,
    livePtyIds,
    recordExit
  })

  const handler = mux.onNotification.mock.calls[0]?.[0] as (
    method: string,
    params: Record<string, unknown>
  ) => void
  if (!handler) {
    throw new Error('notification handler was not registered')
  }

  return {
    handler,
    toAppPtyId,
    dataListeners,
    replayListeners,
    exitListeners,
    livePtyIds,
    recordExit
  }
}

describe('subscribeSshPtyNotifications', () => {
  it('ignores non-PTY notifications without mapping params.id', () => {
    const { handler, toAppPtyId } = createSubscription()

    expect(() => handler('workspace.changed', { snapshot: { revision: 1 } })).not.toThrow()
    expect(() =>
      handler('fs.changed', {
        events: [{ kind: 'update', absolutePath: '/tmp/repo/file.txt' }]
      })
    ).not.toThrow()
    expect(toAppPtyId).not.toHaveBeenCalled()
  })

  it('routes pty.data after validating the string id', () => {
    const { handler, toAppPtyId, dataListeners, livePtyIds } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)

    handler('pty.data', { id: 'pty-1', data: 'hello', rawLength: 5, seq: 9 })

    expect(toAppPtyId).toHaveBeenCalledWith('pty-1')
    expect(livePtyIds.has('ssh:conn@@pty-1')).toBe(true)
    expect(onData).toHaveBeenCalledWith({
      id: 'ssh:conn@@pty-1',
      data: 'hello',
      sequenceChars: 5,
      seq: 9
    })
  })

  it('records pty.exit with the validated relay id', () => {
    const { handler, exitListeners, livePtyIds, recordExit } = createSubscription()
    const onExit = vi.fn()
    exitListeners.add(onExit)
    livePtyIds.add('ssh:conn@@pty-1')

    handler('pty.exit', {
      id: 'pty-1',
      code: 0,
      incarnationId: 'incarnation-1'
    })

    expect(recordExit).toHaveBeenCalledWith('pty-1', 'incarnation-1')
    expect(livePtyIds.has('ssh:conn@@pty-1')).toBe(false)
    expect(onExit).toHaveBeenCalledWith({
      id: 'ssh:conn@@pty-1',
      code: 0,
      incarnationId: 'incarnation-1'
    })
  })

  it('ignores PTY methods with missing ids', () => {
    const { handler, toAppPtyId, dataListeners } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)

    expect(() => handler('pty.data', { data: 'orphan' })).not.toThrow()
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(onData).not.toHaveBeenCalled()
  })
})
