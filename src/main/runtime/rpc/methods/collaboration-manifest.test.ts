import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from './index'

describe('collaboration RPC manifest', () => {
  it('registers local collaboration publish, checkpoint, and ack methods', () => {
    const names = new Set(ALL_RPC_METHODS.map((method) => method.name))

    expect(names.has('orchestration.collaborationConfigure')).toBe(true)
    expect(names.has('orchestration.collaborationPublish')).toBe(true)
    expect(names.has('orchestration.collaborationCheckpoint')).toBe(true)
    expect(names.has('orchestration.collaborationAck')).toBe(true)
  })
})
