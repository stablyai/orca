import { describe, expect, it, vi } from 'vitest'
import { SshPtyProviderNotifications } from './ssh-pty-provider-notifications'
import { MAX_SSH_RELAY_PTY_ID_BYTES } from './ssh-pty-wire-admission'

type NotificationHandler = (method: string, params: Record<string, unknown>) => void

function createSubscription() {
  const notify = vi.fn()
  const onNotification = vi.fn()
  const toAppPtyId = vi.fn((id: string) => `ssh:conn@@${id}`)
  const recordNotification = vi.fn()
  const recordExit = vi.fn()

  const notifications = new SshPtyProviderNotifications(
    { onNotification, notify } as never,
    toAppPtyId,
    recordNotification,
    recordExit
  )

  const handler = onNotification.mock.calls[0]?.[0] as NotificationHandler | undefined
  if (!handler) {
    throw new Error('notification handler was not registered')
  }

  return { handler, toAppPtyId, recordNotification, recordExit, notifications }
}

describe('SshPtyProviderNotifications', () => {
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
    const { handler, toAppPtyId, notifications } = createSubscription()
    const onData = vi.fn()
    notifications.onData(onData)

    handler('pty.data', { id: 'pty-1', data: 'hello', rawLength: 5, seq: 9 })

    expect(toAppPtyId).toHaveBeenCalledWith('pty-1')
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ssh:conn@@pty-1',
        data: 'hello',
        sequenceChars: 5,
        seq: 9
      })
    )
  })

  it('records pty.exit with the validated relay id', () => {
    const { handler, recordExit, notifications } = createSubscription()
    const onExit = vi.fn()
    notifications.onExit(onExit)

    handler('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })

    expect(recordExit).toHaveBeenCalledWith('pty-1', 'incarnation-1')
    expect(onExit).toHaveBeenCalledWith({
      id: 'ssh:conn@@pty-1',
      code: 0,
      incarnationId: 'incarnation-1'
    })
  })

  // Why: every PTY method must reject a missing id at ingress. pty.data is also
  // screened by the delivery-credit layer, so replay/exit are asserted too —
  // otherwise removing the ingress guard leaves this suite green.
  it.each([
    { method: 'pty.data', params: { data: 'orphan' } },
    { method: 'pty.replay', params: { data: 'orphan' } },
    { method: 'pty.exit', params: { code: 0 } }
  ])('ignores $method with a missing id', ({ method, params }) => {
    const { handler, toAppPtyId, recordNotification, recordExit, notifications } =
      createSubscription()
    const listener = vi.fn()
    notifications.onData(listener)
    notifications.onReplay(listener)
    notifications.onExit(listener)

    expect(() => handler(method, params)).not.toThrow()
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(recordNotification).not.toHaveBeenCalled()
    expect(recordExit).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  // Why: the relay id is attacker-influenced and is retained per live PTY, so an
  // oversized id must be dropped at ingress rather than mapped and held.
  it.each(['pty.data', 'pty.replay', 'pty.exit'])(
    'drops %s relay ids past the admission ceiling',
    (method) => {
      const { handler, toAppPtyId, recordNotification, recordExit } = createSubscription()

      handler(method, {
        id: 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES + 1),
        data: 'hello',
        code: 0
      })

      expect(toAppPtyId).not.toHaveBeenCalled()
      expect(recordNotification).not.toHaveBeenCalled()
      expect(recordExit).not.toHaveBeenCalled()
    }
  )

  it('drops pty.exit payloads with a non-numeric code', () => {
    const { handler, recordExit, notifications } = createSubscription()
    const onExit = vi.fn()
    notifications.onExit(onExit)

    handler('pty.exit', { id: 'pty-1', code: 'not-a-number' })

    expect(recordExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('drops pty.replay payloads with non-string data', () => {
    const { handler, recordNotification, notifications } = createSubscription()
    const onReplay = vi.fn()
    notifications.onReplay(onReplay)

    handler('pty.replay', { id: 'pty-1', data: { not: 'a string' } })

    expect(recordNotification).not.toHaveBeenCalled()
    expect(onReplay).not.toHaveBeenCalled()
  })

  it('stops routing after dispose', () => {
    const { handler, notifications } = createSubscription()
    const onData = vi.fn()
    notifications.onData(onData)

    notifications.dispose()
    handler('pty.data', { id: 'pty-1', data: 'hello' })

    expect(onData).not.toHaveBeenCalled()
  })
})
