import { describe, expect, it } from 'vitest'
import { describeSocketEvent } from './socket-event-debug'

describe('describeSocketEvent', () => {
  it('retains only reviewed field names without reading their values', () => {
    const event = {
      code: 1006,
      endpoint: 'wss://paired-desktop.example',
      message: 'credential-secret',
      reason: '/private/repository',
      type: 'error',
      wasClean: false
    }

    expect(describeSocketEvent(event)).toEqual({
      fields: ['code', 'type', 'wasClean']
    })
    expect(JSON.stringify(describeSocketEvent(event))).not.toMatch(
      /paired-desktop|credential|private/
    )
  })

  it('fails closed when event field enumeration throws', () => {
    const event = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('credential-secret')
        }
      }
    )

    expect(describeSocketEvent(event)).toEqual({ fields: [] })
  })
})
