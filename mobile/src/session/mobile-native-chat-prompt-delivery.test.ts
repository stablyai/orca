import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assignMobileNativeChatPromptSubmissions,
  mobileNativeChatPromptDigest,
  mobileNativeChatPromptWasAcknowledged,
  type MobileNativeChatDeliveryCheck
} from './mobile-native-chat-prompt-delivery'

describe('mobile native chat prompt delivery', () => {
  it('matches the desktop full-prompt digest contract', () => {
    const prompt = `  ${'long '.repeat(60)}\nemoji 🚀  `
    expect(mobileNativeChatPromptDigest(prompt)).toBe(
      `sha256:${createHash('sha256').update(prompt).digest('hex')}`
    )
  })

  it('requires an exact newer occurrence', () => {
    const check: MobileNativeChatDeliveryCheck = {
      pendingId: 'pending-1',
      draftKey: 'draft',
      pendingKey: 'pending',
      text: 'hello',
      normalizedText: 'hello',
      baselineTailMessageId: null,
      submittedAt: 20,
      expectedDigest: mobileNativeChatPromptDigest('hello'),
      baseline: { streamId: 'stream', sequence: 2, digest: 'old', receivedAt: 10 },
      deadline: null
    }
    expect(
      mobileNativeChatPromptWasAcknowledged(check, [
        { streamId: 'stream', sequence: 2, digest: check.expectedDigest, receivedAt: 21 }
      ])
    ).toBe(false)
    expect(
      mobileNativeChatPromptWasAcknowledged(check, [
        { streamId: 'stream', sequence: 3, digest: check.expectedDigest, receivedAt: 21 }
      ])
    ).toBe(true)
  })

  it('accepts only a newer host occurrence from a newly observed stream', () => {
    const check: MobileNativeChatDeliveryCheck = {
      pendingId: 'pending-1',
      draftKey: 'draft',
      pendingKey: 'pending',
      text: 'hello',
      normalizedText: 'hello',
      baselineTailMessageId: null,
      submittedAt: 9_000,
      expectedDigest: mobileNativeChatPromptDigest('hello'),
      baseline: { streamId: 'old-stream', sequence: 8, digest: 'old', receivedAt: 8_000 },
      deadline: null
    }

    expect(
      mobileNativeChatPromptWasAcknowledged(check, [
        {
          streamId: 'new-stream',
          sequence: 1,
          digest: check.expectedDigest,
          receivedAt: 100
        }
      ])
    ).toBe(false)
    expect(
      mobileNativeChatPromptWasAcknowledged(check, [
        {
          streamId: 'new-stream',
          sequence: 2,
          digest: check.expectedDigest,
          receivedAt: 8_001
        }
      ])
    ).toBe(true)
  })

  it('assigns one occurrence to only one repeated pending send', () => {
    const digest = mobileNativeChatPromptDigest('repeat')
    const base = {
      draftKey: 'draft',
      pendingKey: 'pending',
      text: 'repeat',
      normalizedText: 'repeat',
      baselineTailMessageId: null,
      submittedAt: 20,
      expectedDigest: digest,
      deadline: null
    }
    const occurrence = {
      streamId: 'stream',
      sequence: 1,
      digest,
      receivedAt: 21
    }

    expect([
      ...assignMobileNativeChatPromptSubmissions(
        [
          { ...base, pendingId: 'first' },
          { ...base, pendingId: 'second' }
        ],
        [occurrence]
      ).keys()
    ]).toEqual(['first'])
    expect([
      ...assignMobileNativeChatPromptSubmissions(
        [
          { ...base, pendingId: 'first', acknowledgedBy: occurrence },
          { ...base, pendingId: 'second' }
        ],
        [occurrence]
      ).keys()
    ]).toEqual(['first'])
  })
})
