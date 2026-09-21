import { describe, expect, it } from 'vitest'
import { SkillRemoteInstallCancellation } from './skill-remote-install-cancellation'

describe('SkillRemoteInstallCancellation', () => {
  it('aborts an active remote transfer and forgets it after settlement', () => {
    const operations = new SkillRemoteInstallCancellation()
    const signal = operations.begin('operation-1')

    expect(operations.cancel('operation-1')).toBe(true)
    expect(signal.aborted).toBe(true)
    operations.finish('operation-1', signal)
    expect(operations.cancel('operation-1')).toBe(false)
  })

  it('rejects overlapping operation identities', () => {
    const operations = new SkillRemoteInstallCancellation()
    operations.begin('operation-1')

    expect(() => operations.begin('operation-1')).toThrow('skill-install-operation-in-progress')
  })
})
