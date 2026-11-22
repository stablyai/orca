import { writeOwnerOnlyFileDurable } from '../filesystem/owner-only-durable-file-write'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import { slackRequesterMemoryScope, createSlackRequesterMemory } from './slack-requester-memory'

const bot = {
  id: 'bot-one',
  folder: 'bot-one',
  slack: null,
  slackApps: [
    { appId: 'A1', teamId: 'T1' },
    { appId: 'A2', teamId: 'T2' }
  ]
}

function slackAsk(thread: string, teamId: string, userId: string, fields = {}) {
  const delivery = ConnectorDelivery.parse({
    kind: 'send',
    deliveryId: thread,
    expiresAt: 1,
    conversation: { source: 'slack', externalId: thread },
    text: 'Remember that I like examples',
    asker: {
      role: 'owner',
      place: { kind: 'public_channel', id: 'C1' },
      text: 'Remember that I like examples',
      context: [],
      userId,
      slackRequester: { teamId, userId },
      ...fields
    }
  })
  if (delivery.kind !== 'send') {
    throw new Error('Expected a send')
  }
  return slackRequesterMemoryScope(bot, delivery.conversation.source, delivery.asker)
}

it('keeps scoped index and topic edits through a restart with no shared or requester fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-slack-memory-'))
  const shared = join(root, 'MEMORY.md')
  try {
    await writeFile(shared, '# Memory\n- Owner only\n')
    const alice = slackAsk('one', 'T1', 'U1')!
    const aliceElsewhere = slackAsk('two', 'T1', 'U1')!
    const bob = slackAsk('one', 'T1', 'U2')!
    const otherTeam = slackAsk('one', 'T2', 'U1')!
    const otherBot = { ...alice, botId: 'bot-two' }
    const memory = createSlackRequesterMemory(root, writeOwnerOnlyFileDurable)
    await Promise.all([
      memory.bind(alice).remember('Prefers examples', '2026-11-22'),
      memory.bind(aliceElsewhere).remember('Uses TypeScript', '2026-11-22'),
      memory.bind(bob).remember('Prefers concise responses', '2026-11-22'),
      memory.bind(otherTeam).remember('Prefers Python', '2026-11-22'),
      memory.bind(otherBot).remember('Prefers Go', '2026-11-22')
    ])
    await memory.bind(alice).remember('Likes concise code examples', '2026-11-22', 'examples')
    const reopened = createSlackRequesterMemory(root, writeOwnerOnlyFileDurable)
    expect(await reopened.bind(aliceElsewhere).read()).toMatchObject({
      index: '- 2026-11-22 Uses TypeScript\n- 2026-11-22 Prefers examples\n',
      topics: ['examples']
    })
    expect(await reopened.bind(bob).read()).toMatchObject({
      index: '- 2026-11-22 Prefers concise responses\n',
      topics: []
    })
    expect((await reopened.bind(otherTeam).read()).index).toBe('- 2026-11-22 Prefers Python\n')
    expect((await reopened.bind(otherBot).read()).index).toBe('- 2026-11-22 Prefers Go\n')
    expect(await reopened.bind(aliceElsewhere).readTopic('examples')).toBe(
      '- 2026-11-22 Likes concise code examples\n'
    )
    expect(await reopened.bind(bob).readTopic('examples')).toBeNull()
    await Promise.all([
      reopened.bind(alice).forget('Prefers examples'),
      reopened.bind(aliceElsewhere).forget('Likes concise code examples', 'examples'),
      reopened.bind(alice).remember('Prefers short examples', '2026-11-22')
    ])
    expect(
      (await createSlackRequesterMemory(root, writeOwnerOnlyFileDurable).bind(alice).read()).index
    ).toBe('- 2026-11-22 Prefers short examples\n- 2026-11-22 Uses TypeScript\n')
    expect(
      await createSlackRequesterMemory(root, writeOwnerOnlyFileDurable)
        .bind(alice)
        .readTopic('examples')
    ).toBe('')
    expect(await readFile(shared, 'utf8')).toBe('# Memory\n- Owner only\n')
    await expect(reopened.bind(alice).readTopic('../MEMORY')).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires a direct stamped author and a configured Slack workspace even for the owner', () => {
  expect(slackAsk('slack:T1:C1:1.2', 'T1', 'U1', { slackRequester: undefined })).toBeNull()
  expect(slackAsk('one', 'T1', 'U1', { app: true })).toBeNull()
  expect(slackAsk('one', 'T1', 'U1', { via: { name: 'bot', userId: 'U2' } })).toBeNull()
  expect(slackAsk('one', 'T3', 'U1')).toBeNull()
})

it('keeps the scope fixed for an in-flight execution and gives an unknown requester no memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-slack-memory-'))
  try {
    const memory = createSlackRequesterMemory(root, writeOwnerOnlyFileDurable)
    const requester = { botId: 'bot-one', teamId: 'T1', userId: 'U1' }
    const first = memory.bind(requester)
    requester.userId = 'U2'
    const second = memory.bind(requester)
    const unknown = memory.bind(null)
    await first.remember('First requester fact', '2026-11-22')
    await second.remember('Second requester fact', '2026-11-22')
    expect(await unknown.remember('Unattributed fact', '2026-11-22')).toBe(false)
    expect(await unknown.forget('First requester fact')).toBe(false)
    expect(await unknown.read()).toEqual({ index: null, topics: [] })
    expect(await unknown.readTopic('examples')).toBeNull()
    expect(await first.forget('Second requester fact')).toBe(false)
    expect((await first.read()).index).toBe('- 2026-11-22 First requester fact\n')
    expect((await second.read()).index).toBe('- 2026-11-22 Second requester fact\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
