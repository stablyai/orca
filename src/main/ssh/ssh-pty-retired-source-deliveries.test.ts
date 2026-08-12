import { describe, expect, it } from 'vitest'
import { SshPtyRetiredSourceDeliveries } from './ssh-pty-retired-source-deliveries'

const source = (deliveryToken: string, relayPtyId = 'pty-1') => ({
  relayPtyId,
  deliveryToken,
  clientGeneration: 2,
  ownerGeneration: 3
})

describe('SshPtyRetiredSourceDeliveries', () => {
  it('retains only the latest canceled token for each ordered PTY stream', () => {
    const retired = new SshPtyRetiredSourceDeliveries()

    for (let token = 0; token < 10_000; token++) {
      retired.retire(1, source(`token-${token}`))
    }

    expect(retired.size).toBe(1)
    expect(retired.has(1, source('token-9999'))).toBe(true)
    expect(retired.has(1, source('token-9998'))).toBe(false)
  })

  it('retires state at the next activation or PTY exit boundary', () => {
    const retired = new SshPtyRetiredSourceDeliveries()
    retired.retire(1, source('old-token'))
    retired.retire(1, source('other-token', 'pty-2'))

    retired.activate('pty-1')

    expect(retired.has(1, source('old-token'))).toBe(false)
    expect(retired.has(1, source('other-token', 'pty-2'))).toBe(true)
    expect(retired.size).toBe(1)
  })
})
