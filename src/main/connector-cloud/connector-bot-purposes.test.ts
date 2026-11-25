// A shared bot's hello carries what it is for, read from SOUL.md as `bot list` reads it, within the
// contract's cap; a bot with no purpose, or shared with no one, carries none.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotPurposeSchema } from '../../../cloud/packages/connector-contract/src/share-messages'
import { CONNECTOR_LIMITS } from '../../../cloud/packages/connector-contract/src/connector-limits'
import { BotSchema, type Bot } from '../../shared/bot-types'
import { starterSoul } from '../../shared/bot-soul'
import { ConnectorBotPurposes, helloBotPurpose } from './connector-bot-purposes'
import { connectorBots } from './connector-places'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function bot(folder: string, shared: boolean): Bot {
  return BotSchema.parse({
    id: `bot-${folder}`,
    name: folder,
    hostId: 'local',
    folder,
    folderWorkspaceId: `ws-${folder}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
    members: [],
    shares: shared
      ? [
          {
            kind: 'account',
            shareId: `share-${folder}`,
            accountId: 'acct-1',
            email: 'teammate@example.com',
            addedAt: 1
          }
        ]
      : [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  })
}

describe('a shared bot’s purpose in the hello', () => {
  it('goes for a shared bot from SOUL.md, and not for one with none or shared with no one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-bot-purposes-'))
    roots.push(root)
    const souls: Record<string, string> = {
      ivy: '# Ivy\n\nTriages flaky tests\nand drafts the fix.\n\n## Notes\n\nMore.',
      blank: starterSoul('blank'),
      solo: 'Works alone.'
    }
    for (const [folder, soul] of Object.entries(souls)) {
      mkdirSync(join(root, folder))
      writeFileSync(join(root, folder, 'SOUL.md'), soul)
    }
    const bots = [bot('ivy', true), bot('blank', true), bot('solo', false)]
    const purposes = new ConnectorBotPurposes({
      bots: () => bots,
      readSoul: async ({ folder }) => readFileSync(join(root, folder, 'SOUL.md'), 'utf8')
    })
    let changes = 0
    purposes.onChange(() => changes++)
    await purposes.refresh()

    const hello = connectorBots({ getBots: () => bots }, true, [], null, (id) => purposes.of(id))
    // As the cloud's hello reads it.
    const said = hello.map((entry) => ({
      ...entry,
      botPurpose: BotPurposeSchema.optional().parse(entry.botPurpose)
    }))
    expect(said.map((entry) => [entry.id, entry.botPurpose])).toEqual([
      ['bot-ivy', 'Triages flaky tests and drafts the fix.'],
      ['bot-blank', undefined],
      ['bot-solo', undefined]
    ])
    expect(changes).toBe(1)
    await purposes.refresh()
    expect(changes).toBe(1)
  })

  it('is cut to the contract’s cap without splitting a pair', () => {
    const max = CONNECTOR_LIMITS.maxBotPurposeLength
    expect(helloBotPurpose('')).toBeUndefined()
    expect(helloBotPurpose(null)).toBeUndefined()
    for (const soul of ['a'.repeat(max * 2), `${'a'.repeat(max - 1)}😀 more`]) {
      const purpose = helloBotPurpose(soul) ?? ''
      expect(purpose.length).toBeLessThanOrEqual(max)
      expect(purpose).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })
})
