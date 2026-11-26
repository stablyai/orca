import Database from '../sqlite/sync-database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { eligibleProfiles, readFeishuMessage } from './feishu-cli'
import { dmKey } from './feishu-binding'
import { FeishuInbox } from './feishu-inbox'
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

it('offers a shared app once under the profile the CLI actually resolves for its ID', () => {
  const alias = { ...profile, name: 'second-name' }
  expect(eligibleProfiles([profile, alias])).toEqual([profile])
  expect(eligibleProfiles([alias, profile])).toEqual([alias])
  expect(eligibleProfiles([profile, { ...alias, name: profile.appId }])).not.toContainEqual(profile)
  expect(eligibleProfiles([profile, { ...alias, name: profile.name }])).toEqual([])
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
