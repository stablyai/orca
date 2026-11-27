import { describe, expect, it, vi } from 'vitest'
import { BotPackageV1Schema } from '../../../shared/bots/bot-package'
import type { BotController } from '../bot-controller'
import { localBotHomeFilesystem } from '../bot-home'
import { createBotFromShare, lookForOlderClient } from './bot-share-create'
import type { BotRecipientContent } from './bot-share-recipient'

const shared: Parameters<typeof lookForOlderClient>[2] = {
  avatar: { mascot: 'H1', color: '#f4c4cf', outfit: 'tie' }
}

describe('a shared bot created by a client from before shared looks', () => {
  it("gets the shared mascot's color and outfit", () => {
    expect(lookForOlderClient({ avatar: 'mascot:H1' }, {}, shared)).toEqual({
      avatarColor: '#f4c4cf',
      avatarOutfit: 'tie'
    })
  })

  it('keeps the look a newer client sent, and gives another mascot none', () => {
    expect(lookForOlderClient({ avatar: 'mascot:H1' }, { lookSent: true }, shared)).toEqual({})
    expect(lookForOlderClient({ avatar: 'mascot:A1' }, {}, shared)).toEqual({})
  })

  it('creates the bot wearing the shared look', async () => {
    const recipient: BotRecipientContent = {
      kind: 'recipient',
      source: {
        shareId: 's1',
        packageId: 'p1',
        versionId: 'v1',
        archiveSha256: '',
        packageDigest: '',
        publisher: null,
        publishedAt: '2026-11-22T00:00:00.000Z'
      },
      bot: BotPackageV1Schema.parse({
        schemaVersion: 1,
        name: 'Release notes',
        ...shared,
        purpose: '',
        agentHint: 'claude',
        skills: [],
        tools: [],
        connectors: [],
        schedules: [],
        eventSuggestions: [],
        memory: []
      }),
      files: [],
      avatarBase64: null,
      notIncluded: [],
      flags: [],
      reviewDigest: ''
    }
    // Stops at the bot record: what it is created with is the whole question.
    const create = vi.fn<BotController['create']>().mockRejectedValue(new Error('stop'))
    const made = createBotFromShare(
      {
        bots: { create, delete: vi.fn(), setAvatarImage: vi.fn() },
        filesystem: localBotHomeFilesystem,
        botsRoot: () => '',
        createPausedSchedule: vi.fn(),
        reviewed: async () => recipient
      },
      { name: 'Release notes', avatar: 'mascot:H1', fromShare: { reviewId: 'r1', toolIds: [] } }
    )
    await expect(made).rejects.toThrow('stop')
    expect(create.mock.calls[0]?.[0]).toMatchObject({ avatarColor: '#f4c4cf', avatarOutfit: 'tie' })
  })
})
