import { describe, expect, it, vi } from 'vitest'
import { nameConversationPlace } from './external-conversation-place'

describe('nameConversationPlace', () => {
  it('names GitHub as repo#number and Linear by its issue key, with no lookup', async () => {
    const nameChannel = vi.fn(async () => '#never')
    await expect(
      nameConversationPlace(
        'github',
        { kind: 'pull_request', id: 'stablyai/orca#3412' },
        'b1',
        nameChannel
      )
    ).resolves.toBe('orca#3412')
    await expect(
      nameConversationPlace('linear', { kind: 'issue', id: 'ENG-42' }, 'b1', nameChannel)
    ).resolves.toBe('ENG-42')
    expect(nameChannel).not.toHaveBeenCalled()
  })

  it("asks the cloud for a Slack channel's name, and names no direct message", async () => {
    const nameChannel = vi.fn(async () => '#orca')
    await expect(
      nameConversationPlace('slack', { kind: 'public_channel', id: 'C9' }, 'b1', nameChannel)
    ).resolves.toBe('#orca')
    await expect(
      nameConversationPlace('slack', { kind: 'direct_message', id: 'D1' }, 'b1', nameChannel)
    ).resolves.toBeNull()
    expect(nameChannel).toHaveBeenCalledTimes(1)
  })

  it('leaves the place unnamed when the cloud cannot say', async () => {
    await expect(
      nameConversationPlace('slack', { kind: 'private_channel', id: 'G1' }, 'b1', async () => {
        throw new Error('offline')
      })
    ).resolves.toBeNull()
    await expect(
      nameConversationPlace('slack', { kind: 'public_channel', id: 'C9' }, 'b1', undefined)
    ).resolves.toBeNull()
  })
})
