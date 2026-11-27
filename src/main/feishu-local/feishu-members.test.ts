import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FeishuMessageIngress } from './feishu-message-ingress'
import { FeishuInbox } from './feishu-inbox'
import { threadKey } from './feishu-route-key'
import { feishuAsker } from '../../shared/bots/feishu-members'
import { verifiedOriginal } from './feishu-message'
import type { BotMember } from '../../shared/bot-types'
import type { FeishuMessage } from './feishu-cli'

const grant: BotMember = {
  id: 'ou_member',
  name: 'Member',
  source: 'feishu-local',
  workspaceId: 'cli_test'
}
const event: FeishuMessage = {
  type: 'im.message.receive_v1',
  chat_type: 'p2p',
  message_type: 'text',
  sender_type: 'user',
  create_time: '1800000000000',
  message_id: 'om_pair',
  event_id: 'pair',
  sender_id: 'ou_owner',
  chat_id: 'oc_owner_dm',
  content: 'pair'
}

it('persists the real asker, scopes grants to the app, and rejects revoked or cross-person choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-members-'))
  const file = join(dir, 'inbox.sqlite')
  let store = new FeishuInbox(file)
  try {
    store.pair(
      'scope',
      store.add('scope', 'bot', { name: 'test', appId: 'cli_test', brand: 'feishu' }),
      event
    )
    const [b] = store.bindings('scope')
    const root = 'om_root'
    const external = threadKey(b, 'oc_group', root, grant.id).externalId
    expect(external).not.toBe(threadKey(b, 'oc_group', root).externalId)
    expect(external).not.toBe(threadKey(b, 'oc_group', root, 'ou_other').externalId)
    const m = {
      ...event,
      chat_type: 'group' as const,
      chat_id: 'oc_group',
      root_id: root,
      sender_id: grant.id,
      message_id: 'om_member',
      event_id: 'member',
      create_time: '1800000000100'
    }
    store.putRoute(b.account, m.message_id, {
      external,
      root,
      chat: m.chat_id,
      original: m.message_id,
      group: true
    })
    for (const members of [
      [],
      [{ ...grant, workspaceId: 'cli_other' }],
      [{ ...grant, source: 'slack' }],
      [{ ...grant, kind: 'app' as const }]
    ]) {
      store.accept(b, m, [], members)
      expect(store.next(b.account)).toBeUndefined()
    }
    store.accept(b, { ...m, sender_type: 'bot' }, [], [grant])
    store.accept(b, { ...m, chat_id: 'oc_other' }, [], [grant])
    expect(store.next(b.account)).toBeUndefined()
    store.accept(b, m, [], [grant])
    store.close()
    store = new FeishuInbox(file)
    expect(store.next(b.account)?.sender).toBe('ou_member')
    expect(feishuAsker(b, [grant], store.next(b.account)!.sender)).toEqual({
      userId: 'ou_member',
      role: 'member',
      name: 'Member'
    })
    expect(feishuAsker(b, [], store.next(b.account)!.sender)).toBeNull()
    store.admitted(b.account, m.message_id)
    expect(store.sender(b.account, m.message_id)).toBe('ou_member')
    expect(store.laneSender(b.account, external)).toBe('ou_member')
    store.putCard(b.account, 'q', external, m.message_id, m.chat_id, {
      kind: 'choices',
      text: 'Choose',
      options: [{ id: 'yes', label: 'Yes' }]
    })
    store.postedCard(b.account, 'q', 1, 'om_card')
    for (const actor of ['ou_other', 'ou_owner']) {
      expect(
        store.claimCardFor(
          b,
          [grant, { ...grant, id: 'ou_other' }],
          actor,
          'om_card',
          m.chat_id,
          'yes'
        )
      ).toBeNull()
    }
    expect(store.claimCardFor(b, [], grant.id, 'om_card', m.chat_id, 'yes')).toBeNull()
    expect(store.getCard(b.account, 'q')?.state).toBe('open')
    expect(store.claimCardFor(b, [grant], grant.id, 'om_card', 'oc_wrong', 'yes')).toBeNull()
    expect(store.claimCardFor(b, [grant], grant.id, 'om_card', m.chat_id, 'yes')?.state).toBe(
      'claimed'
    )
    expect(store.claimCardFor(b, [grant], grant.id, 'om_card', m.chat_id, 'yes')).toBeNull()
    store.putCard(b.account, 'approval', external, m.message_id, m.chat_id, {
      kind: 'prompt',
      ownerOnly: true,
      text: 'Started in Orca',
      options: [{ id: 'yes', label: 'Yes' }]
    })
    store.postedCard(b.account, 'approval', 1, 'om_approval')
    expect(store.claimCardFor(b, [grant], grant.id, 'om_approval', m.chat_id, 'yes')).toBeNull()
    expect(store.claimCardFor(b, [grant], 'ou_owner', 'om_approval', m.chat_id, 'yes')?.state).toBe(
      'claimed'
    )
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('validates a member attachment against that sender, without treating them as the binding owner', () => {
  const b = {
    account: 'a',
    bot: 'bot',
    profile: 'test',
    app: 'cli_test',
    owner: 'ou_owner',
    chat: 'oc_member',
    pairedAt: 1
  }
  const message = {
    message_id: 'om_resource',
    chat_id: 'oc_member',
    msg_type: 'image',
    sender: { id: 'ou_member', id_type: 'open_id', sender_type: 'user' },
    body: { content: '{"image_key":"img_test"}' }
  }
  const read = (sender: string) =>
    verifiedOriginal([message], 'om_resource', b.chat, sender, 'image')
  expect(read('ou_member')).toBe(message.body.content)
  expect(read('ou_other')).toBeUndefined()
  expect(read(b.owner)).toBeUndefined()
  expect(b.owner).toBe('ou_owner')
})

vi.mock('./feishu-cli', () => ({
  feishuCommand: async () => ({
    ok: true,
    identity: 'bot',
    data: { open_id: 'ou_bot', app_name: 'Test', items: [] }
  })
}))

it('requires each group asker’s first mention, preserves their own lane, and revokes ingress live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-ingress-'))
  const store = new FeishuInbox(join(dir, 'inbox.sqlite'))
  try {
    store.pair(
      'scope',
      store.add('scope', 'bot', { name: 'test', appId: 'cli_test', brand: 'feishu' }),
      event
    )
    const [b] = store.bindings('scope')
    let members: BotMember[] = [grant]
    const ingress = new FeishuMessageIngress(
      {
        messageRoute: async (...args) => store.messageRoute(...args),
        laneRoute: async (...args) => store.laneRoute(...args),
        putRoute: async (...args) => store.putRoute(...args),
        accept: async (...args) => store.accept(...args)
      },
      new AbortController().signal,
      () => members
    )
    const owner = {
      ...event,
      message_id: 'om_root',
      event_id: 'root',
      chat_id: 'oc_group',
      chat_type: 'group' as const,
      create_time: '1800000000200',
      mentions: [{ id: 'ou_bot', key: '@bot' }]
    }
    await ingress.receive(b, owner)
    store.admitted(b.account, owner.message_id)
    const m = {
      ...owner,
      root_id: owner.message_id,
      message_id: 'om_member',
      event_id: 'member',
      sender_id: grant.id,
      mentions: []
    }
    await ingress.receive(b, m)
    expect(store.next(b.account)).toBeUndefined()
    await ingress.receive(b, { ...m, mentions: owner.mentions })
    expect(store.next(b.account)?.sender).toBe(grant.id)
    expect(store.messageRoute(b.account, m.message_id)?.external).not.toBe(
      store.messageRoute(b.account, owner.message_id)?.external
    )
    store.admitted(b.account, m.message_id)
    const follow = { ...m, message_id: 'om_follow', event_id: 'follow' }
    await ingress.receive(b, follow)
    expect(store.next(b.account)?.mid).toBe('om_follow')
    expect(store.messageRoute(b.account, follow.message_id)?.external).toBe(
      store.messageRoute(b.account, m.message_id)?.external
    )
    store.admitted(b.account, follow.message_id)
    members = []
    await ingress.receive(b, { ...follow, message_id: 'om_revoked', event_id: 'revoked' })
    expect(store.next(b.account)).toBeUndefined()
    expect(store.messageRoute(b.account, 'om_revoked')).toBeNull()
    members = [grant]
    const dm = {
      ...m,
      root_id: undefined,
      chat_type: 'p2p' as const,
      chat_id: 'oc_member_dm',
      message_id: 'om_dm',
      event_id: 'dm'
    }
    await ingress.receive(b, dm)
    expect(store.next(b.account)?.sender).toBe(grant.id)
    expect(store.messageRoute(b.account, dm.message_id)?.chat).toBe('oc_member_dm')
    expect(store.bindings('scope')[0].owner).toBe('ou_owner')
    expect(store.bindings('scope')[0].chat).toBe('oc_owner_dm')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
