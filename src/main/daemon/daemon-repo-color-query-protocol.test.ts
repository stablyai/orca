import { describe, expect, it } from 'vitest'
import { supportsRepoColorQueryReplyColors } from './daemon-protocol-version'

describe('project colour query protocol gate', () => {
  it('sends project colours only to daemons that answer each session from them', () => {
    expect(supportsRepoColorQueryReplyColors(43)).toBe(false)
    expect(supportsRepoColorQueryReplyColors(44)).toBe(true)
  })
})
