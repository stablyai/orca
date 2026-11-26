import Database from '../sqlite/sync-database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { eligibleProfiles, readFeishuMessage } from './feishu-cli'
import { dmKey } from './feishu-binding'
import { FeishuInbox } from './feishu-inbox'
import { readFeishuGroupMessage } from './feishu-message'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'

const profile = { name: 'example', appId: 'cli_example', brand: 'feishu' }
const event = {
  type: 'im.message.receive_v1',
  chat_type: 'p2p',
  message_type: 'text',
  create_time: '1800000000000',
  event_id: 'event-one',
  message_id: 'om_first',
  chat_id: 'oc_one',
  sender_id: 'ou_one',
  content: 'Hello'
} as const

it('drops unsupported streams and rejects an alias that shadows a pinned app', () => {
  expect(readFeishuMessage(JSON.stringify(event))).toEqual(event)
  expect(readFeishuMessage(JSON.stringify({ ...event, chat_type: 'group' }))).toBeNull()
  expect(readFeishuMessage(JSON.stringify({ ...event, message_type: 'post' }))).toBeNull()
  expect(readFeishuMessage(JSON.stringify({ ...event, sender_id: '' }))).toBeNull()
  expect(
    eligibleProfiles([profile, { ...profile, name: 'cli_example', appId: 'cli_other' }])
  ).not.toContainEqual(profile)
})

it('accepts only a human in the configured test group explicitly mentioning this SDK bot', () => {
  const policy = { chatId: 'oc_group', members: ['ou_member'] }
  const input = {
    app_id: 'cli_example',
    event_id: 'ev_group',
    tenant_key: 'tenant',
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_member' },
      tenant_key: 'tenant'
    },
    message: {
      chat_type: 'topic_group',
      chat_id: 'oc_group',
      message_id: 'om_follow_up',
      root_id: 'om_root',
      message_type: 'text',
      create_time: '1800000000001',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' } },
        { key: '@_user_10', id: { open_id: 'ou_another' } }
      ],
      content: '{"text":"@_user_1 Compare @_user_10"}'
    }
  }
  const read = (value: unknown) => readFeishuGroupMessage(value, 'cli_example', 'ou_bot', policy)
  expect(read(input)).toMatchObject({
    message_id: 'om_follow_up',
    content: 'Compare @_user_10',
    group: {
      chatId: 'oc_group',
      tenant: 'tenant',
      rootId: 'om_root',
      inThread: true,
      sender: 'ou_member'
    }
  })
  for (const rejected of [
    { ...input, app_id: 'cli_other' },
    { ...input, sender: { ...input.sender, sender_type: 'app' } },
    { ...input, sender: { ...input.sender, tenant_key: 'outside' } },
    { ...input, sender: { ...input.sender, sender_id: { open_id: 'ou_other' } } },
    { ...input, message: { ...input.message, chat_id: 'oc_other' } },
    { ...input, message: { ...input.message, message_type: 'post' } },
    { ...input, message: { ...input.message, mentions: input.message.mentions.slice(1) } }
  ]) {
    expect(read(rejected)).toBeNull()
  }
})

it('offers a shared app once under the profile the CLI actually resolves for its ID', () => {
  const alias = { ...profile, name: 'second-name' }
  expect(eligibleProfiles([profile, alias])).toEqual([profile])
  expect(eligibleProfiles([alias, profile])).toEqual([alias])
  expect(eligibleProfiles([profile, { ...alias, name: profile.appId }])).not.toContainEqual(profile)
  expect(eligibleProfiles([profile, { ...alias, name: profile.name }])).toEqual([])
})

it('keeps a pending group delivery out of the inbox read by a DM-only build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-group-downgrade-'))
  const file = join(dir, 'inbox.sqlite')
  const inbox = new FeishuInbox(file)
  try {
    const b = inbox.add('scope', 'bot', {
      appId: 'cli_example',
      sealedSecret: 'sealed',
      group: { chatId: 'oc_group', members: ['ou_member'] }
    })
    expect(inbox.pair('scope', b, event)).toBe(true)
    const [paired] = inbox.bindings('scope')
    inbox.accept(paired, {
      ...event,
      chat_type: 'group',
      chat_id: 'oc_group',
      sender_id: 'ou_member',
      message_id: 'om_group',
      event_id: 'e_group',
      create_time: '1800000000001',
      group: {
        chatId: 'oc_group',
        tenant: 'tenant',
        rootId: 'om_group',
        inThread: false,
        sender: 'ou_member'
      }
    })
    inbox.accept(paired, {
      ...event,
      message_id: 'om_dm',
      event_id: 'e_dm',
      create_time: '1800000000002'
    })
    expect(inbox.next(b.account)?.mid).toBe('om_group')
    const oldReader = new Database(file)
    try {
      const legacyRead = oldReader
        .prepare(
          'SELECT mid FROM inbox WHERE account=? AND body IS NOT NULL AND review=0 ORDER BY rowid LIMIT 1'
        )
        .get(b.account)
      expect(legacyRead).toEqual({ mid: 'om_dm' })
    } finally {
      oldReader.close()
    }
  } finally {
    inbox.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps the pairing, actor, original DM and both replay keys bound across a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-inbox-'))
  const path = join(dir, 'inbox.sqlite')
  let inbox = new FeishuInbox(path)
  const other = new FeishuInbox(path)
  try {
    const b = inbox.add('first', 'bot', profile)
    expect(other.bindings('second')).toEqual([])
    expect(() => other.add('second', 'another', profile)).toThrow()
    expect(inbox.pair('first', b, event)).toBe(true)
    inbox.close()
    inbox = new FeishuInbox(path)
    const [bound] = inbox.bindings('first')
    expect(cloudConversation(dmKey(bound))).toBeNull()
    const next = { ...event, create_time: '1800000000100', message_id: 'om_next', event_id: 'next' }
    for (const denied of [
      event,
      { ...next, sender_id: 'ou_other' },
      { ...next, chat_id: 'oc_other' },
      { ...next, create_time: '1799999999999' }
    ]) {
      inbox.accept(bound, denied)
    }
    expect(inbox.next(b.account)).toBeUndefined()
    inbox.accept(bound, next)
    inbox.admitted(b.account, next.message_id)
    inbox.accept(bound, { ...next, message_id: 'om_another' })
    inbox.accept(bound, { ...next, event_id: 'other' })
    expect(inbox.next(b.account)).toBeUndefined()
    expect(inbox.postWindowStart(b.account, 'om_next', 1000)).toBe(1000)
    expect(inbox.postWindowStart(b.account, 'om_next', 1000 + 55 * 60_000)).toBe(1000)
    expect(inbox.postWindowStart(b.account, 'om_unknown', 1000)).toBeNull()
    other.remove('second', 'bot', b.account)
    expect(inbox.bindings('first')).toHaveLength(1)
    inbox.remove('first', 'bot', b.account)
    const replacement = inbox.add('first', 'bot', profile)
    inbox.remove('first', 'bot', b.account)
    expect(inbox.bindings('first')).toEqual([replacement])
  } finally {
    inbox.close()
    other.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('opens a legacy paired CLI grant without changing its identity and reserves both transports in the same database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-upgrade-'))
  const file = join(dir, 'inbox.sqlite')
  try {
    const old = new Database(file)
    old.exec(`CREATE TABLE bindings(account TEXT PRIMARY KEY, scope TEXT NOT NULL, bot TEXT NOT NULL, profile TEXT NOT NULL, app TEXT NOT NULL UNIQUE, owner TEXT, chat TEXT, pairedAt INTEGER, UNIQUE(scope,bot));
      INSERT INTO bindings VALUES('old-account','scope','old-bot','old-profile','cli_old','ou_one','oc_one',42)`)
    old.close()
    const store = new FeishuInbox(file)
    try {
      const oldGrant = {
        account: 'old-account',
        bot: 'old-bot',
        profile: 'old-profile',
        app: 'cli_old',
        owner: 'ou_one',
        chat: 'oc_one',
        pairedAt: 42
      }
      expect(store.bindings('scope')).toEqual([oldGrant])
      expect(store.credential(oldGrant.account)).toBeNull()
      expect(() =>
        store.add('scope', 'other', { appId: 'cli_old', sealedSecret: 'encrypted' })
      ).toThrow()
      expect(() =>
        store.add('scope', 'old-bot', { appId: 'cli_new', sealedSecret: 'encrypted' })
      ).toThrow()
      const sdk = store.add('scope', 'new-bot', { appId: 'cli_new', sealedSecret: 'encrypted' })
      expect(sdk.profile).toBeNull()
      expect(store.credential(sdk.account)).toBe('encrypted')
      expect(() => store.add('another', 'another', { ...profile, appId: 'cli_new' })).toThrow()
      expect(new Set(store.bindings('scope'))).toEqual(new Set([oldGrant, sdk]))
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
