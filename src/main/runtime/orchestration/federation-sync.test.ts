import { describe, expect, it } from 'vitest'
import { parseRelayedMessage } from './federation-sync'

describe('federation relay parsing', () => {
  it('accepts a supported message type', () => {
    expect(
      parseRelayedMessage(
        JSON.stringify({ subject: 'done', body: 'Finished', type: 'worker_done' })
      )
    ).toMatchObject({ type: 'worker_done', priority: 'normal' })
  })

  it('rejects an unsupported type before it reaches the database constraint', () => {
    expect(() =>
      parseRelayedMessage(JSON.stringify({ subject: 'bad', body: 'Blocked', type: 'invented' }))
    ).toThrowError('Federated relay message type invented is not supported.')
  })
})
