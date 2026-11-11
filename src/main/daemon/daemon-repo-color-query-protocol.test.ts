import { describe, expect, it } from 'vitest'
import { supportsRepoColorQueryReplyColors } from './protocol/daemon-protocol-version'

describe('project colour query protocol gate', () => {
  it('sends project colours only to daemons that answer each session from them', () => {
    expect(supportsRepoColorQueryReplyColors(55)).toBe(false)
    expect(supportsRepoColorQueryReplyColors(56)).toBe(true)
  })
})
