import { describe, expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'

describe('RelayDispatcher handler registration', () => {
  it('rejects a duplicate notification handler instead of silently overwriting', () => {
    const dispatcher = new RelayDispatcher(() => true)
    try {
      dispatcher.onNotification('pty.ackData', () => {})
      expect(() => dispatcher.onNotification('pty.ackData', () => {})).toThrow(
        'Notification handler already registered: pty.ackData'
      )
    } finally {
      dispatcher.dispose()
    }
  })

  it('rejects a duplicate request handler instead of silently overwriting', () => {
    const dispatcher = new RelayDispatcher(() => true)
    try {
      dispatcher.onRequest('relay.status', async () => ({ ok: true }))
      expect(() => dispatcher.onRequest('relay.status', async () => ({ ok: true }))).toThrow(
        'Request handler already registered: relay.status'
      )
    } finally {
      dispatcher.dispose()
    }
  })

  it('allows the same method name as a request and a notification', () => {
    const dispatcher = new RelayDispatcher(() => true)
    try {
      dispatcher.onNotification('session.registerRoot', () => {})
      expect(() =>
        dispatcher.onRequest('session.registerRoot', async () => ({ ok: true }))
      ).not.toThrow()
    } finally {
      dispatcher.dispose()
    }
  })
})
