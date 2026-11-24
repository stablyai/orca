import { describe, expect, it } from 'vitest'
import { ConnectorHelloResponseSchema } from './hello-messages.js'
import { ConnectorWakeAdminRequestSchema } from './wake-messages.js'

describe('wake offer on the hello answer', () => {
  it('reads a valid offer and drops an unreadable one without failing the hello', () => {
    const offer = { wakeUrl: 'wss://wake.example.test/v1/connector/wake', safetyPollMs: 180_000 }
    expect(ConnectorHelloResponseSchema.parse({ helloRev: 3, wake: offer }).wake).toEqual(offer)
    for (const wake of [
      { wakeUrl: 'ws://wake.example.test/v1/connector/wake', safetyPollMs: 180_000 },
      { wakeUrl: 'wss://wake.example.test', safetyPollMs: 1 },
      { wakeUrl: 'not a url', safetyPollMs: 180_000 },
      { future: true }
    ]) {
      expect(ConnectorHelloResponseSchema.parse({ helloRev: 3, wake })).toEqual({ helloRev: 3 })
    }
    expect(ConnectorHelloResponseSchema.parse({ helloRev: 3 })).toEqual({ helloRev: 3 })
  })

  it('takes host ids of the shape sub:mid only', () => {
    const mid = 'A'.repeat(16)
    expect(ConnectorWakeAdminRequestSchema.safeParse({ hosts: [`user:1:${mid}`] }).success).toBe(true)
    expect(ConnectorWakeAdminRequestSchema.safeParse({ hosts: ['canary:health'] }).success).toBe(false)
    expect(ConnectorWakeAdminRequestSchema.safeParse({ hosts: [`:${mid}`] }).success).toBe(false)
  })
})
