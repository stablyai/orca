// U6: the additive `forgotten` dispatch disposition must coalesce to legacy
// `failed` for readers that predate it; every other status passes through
// unchanged.
import { describe, expect, it } from 'vitest'
import { projectDispatchStatusForLegacyReaders, type DispatchStatus } from './types'

describe('projectDispatchStatusForLegacyReaders', () => {
  it('coalesces forgotten to failed so a legacy reader blocks until an explicit retry', () => {
    expect(projectDispatchStatusForLegacyReaders('forgotten')).toBe('failed')
  })

  it('passes every non-forgotten status through unchanged', () => {
    const passthrough: Exclude<DispatchStatus, 'forgotten'>[] = [
      'pending',
      'dispatched',
      'completed',
      'failed',
      'circuit_broken'
    ]
    for (const status of passthrough) {
      expect(projectDispatchStatusForLegacyReaders(status)).toBe(status)
    }
  })
})
