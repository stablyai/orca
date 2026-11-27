import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import * as attachmentRegistry from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { verifiedOriginal } from './feishu-message'
import { feishuInput } from './feishu-resources'
import { feishuResponseCard } from './feishu-response-render'
import { dmKey } from './feishu-binding'
import { FeishuInbox } from './feishu-inbox'
import Database from '../sqlite/sync-database'
import { FeishuReplyFiles } from './feishu-reply-files'

it('migrates existing file receipts without reposting them or changing their idempotency key', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE inbox(account TEXT, mid TEXT, review INTEGER DEFAULT 0, reply_done INTEGER DEFAULT 0, PRIMARY KEY(account,mid));
      INSERT INTO inbox(account,mid) VALUES('account','om_original');
      CREATE TABLE reply_files(account TEXT,mid TEXT,name TEXT,bytes BLOB,file_key TEXT,posted INTEGER DEFAULT 0,PRIMARY KEY(account,mid),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
      INSERT INTO reply_files VALUES('account','om_original','old.txt',NULL,'file_old',1);`)
    const files = new FeishuReplyFiles(db)
    expect(files.artifacts('account', 'om_original')).toEqual([
      { name: 'old.txt', bytes: null, key: 'file_old', posted: 1, part: 'file' }
    ])
    files.stageFile('account', 'om_original', 'new.txt', Buffer.from('new'))
    const reopened = new FeishuReplyFiles(db)
    expect(reopened.artifacts('account', 'om_original')).toHaveLength(2)
    expect(reopened.artifacts('account', 'om_original')[0].posted).toBe(1)
    expect(reopened.artifacts('account', 'om_original')[1].part).not.toBe('file')
    db.exec("DELETE FROM inbox WHERE account='account'")
    expect(reopened.artifacts('account', 'om_original')).toEqual([])
  } finally {
    db.close()
  }
})

const verified = {
  account: 'example-account',
  profile: null,
  bot: 'example-bot',
  app: 'cli_example',
  owner: 'ou_owner',
  chat: 'oc_owner',
  pairedAt: 1
}
const original = {
  message_id: 'om_picture',
  chat_id: verified.chat,
  msg_type: 'image',
  sender: { id_type: 'open_id', sender_type: 'user', id: verified.owner },
  body: { content: JSON.stringify({ image_key: 'img_example' }) }
}

it('accepts a resource only under the original human, DM, message and resource type', () => {
  const read = (item: unknown) =>
    verifiedOriginal([item], original.message_id, verified.chat, verified.owner, 'image')
  expect(read(original)).toBe(original.body.content)
  for (const item of [
    { ...original, message_id: 'om_another' },
    { ...original, chat_id: 'oc_another' },
    { ...original, msg_type: 'file' },
    { ...original, deleted: true },
    { ...original, sender: { ...original.sender, id: 'ou_other' } },
    { ...original, sender: { ...original.sender, sender_type: 'app' } }
  ]) {
    expect(read(item)).toBeUndefined()
  }
})

it('leaves external image references in plain text without activating card resources', () => {
  for (const text of [
    '![photo](https://example.org/test.png)',
    '<IMG src="https://example.org/test.png">'
  ]) {
    const card = feishuResponseCard(
      {
        kind: 'response',
        text: 'Done',
        options: [],
        response: { phase: 'done', final: text, progress: [], trace: [] }
      },
      'Example'
    )
    expect(card.body.elements).toEqual([{ tag: 'div', text: { tag: 'plain_text', content: text } }])
  }
})

it('keeps identically named original messages and generated uploads separate across two apps', () => {
  const db = new FeishuInbox(':memory:')
  try {
    const event = {
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1800000000001',
      event_id: 'pair',
      message_id: 'om_pair',
      sender_id: 'ou_example',
      chat_id: 'oc_example',
      content: 'example'
    } as const
    for (const name of ['alpha', 'beta']) {
      const b = db.add('scope', name, { name, appId: `cli_${name}`, brand: 'feishu' })
      db.pair('scope', b, event)
    }
    const [first, second] = db.bindings('scope')
    expect(dmKey(first)).not.toEqual(dmKey(second))
    for (const b of [first, second]) {
      db.accept(b, {
        ...event,
        create_time: '1800000000002',
        message_id: 'om_original',
        event_id: 'original'
      })
    }
    const mid = 'om_original'
    const bytes = Buffer.from('synthetic')
    db.stageFile(first.account, mid, 'receipt.txt', bytes)
    db.stageFile(first.account, mid, 'receipt.txt', bytes)
    db.stageFile(first.account, mid, 'other.txt', bytes)
    expect(() => db.stageFile(first.account, mid, 'receipt.txt', Buffer.from('changed'))).toThrow()
    expect(db.artifacts(first.account, mid)).toHaveLength(2)
    expect(db.artifacts(second.account, mid)).toEqual([])
    expect(db.takeProgress(first.account, mid)).toBe(true)
    expect(db.takeProgress(first.account, mid)).toBe(false)
    expect(db.takeProgress(second.account, mid)).toBe(true)
    db.uploaded(first.account, mid, 'receipt.txt', 'file_example')
    expect(db.artifacts(first.account, mid)[0]).toMatchObject({
      bytes: null,
      key: 'file_example',
      posted: 0
    })
    db.stageFile(first.account, mid, 'receipt.txt', bytes)
    db.filePosted(first.account, mid, 'receipt.txt')
    expect(db.artifacts(first.account, mid)[0]?.posted).toBe(1)
    db.remove('scope', first.bot, first.account)
    expect(db.artifacts(first.account, mid)).toEqual([])
    expect(db.next(second.account)?.mid).toBe(mid)
  } finally {
    db.close()
  }
})

it('reuses a present inbox attachment but rechecks the original after the unclaimed file is swept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-retry-'))
  const store = new AgentSessionAttachmentStore(dir, { hasSession: () => true })
  const current = vi
    .spyOn(attachmentRegistry, 'getAgentSessionAttachmentStore')
    .mockReturnValue(store)
  const read = vi.fn(async (_mid: string) => [
    { ...original, sender: { ...original.sender, sender_type: 'app' } }
  ])
  const loadResource = { original: read, download: vi.fn() }
  try {
    const path = await store.storeFile('example.png', Buffer.from('synthetic existing upload'))
    const row = { mid: original.message_id, kind: 'image' as const, body: 'synthetic', path }
    const stored = vi.fn()
    const load = () =>
      feishuInput(loadResource, { stored }, verified, row, 'codex', new AbortController().signal)
    expect((await load()).storedImages).toEqual([path])
    expect(read).not.toHaveBeenCalled()
    await rm(path)
    const expired = await load()
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0][0]).toBe(original.message_id)
    expect(expired.storedImages).toBeUndefined()
    expect(stored).not.toHaveBeenCalled()
  } finally {
    current.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

it('rechecks skipped post images and retains verified text and earlier images if another download fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-inline-'))
  const current = vi
    .spyOn(attachmentRegistry, 'getAgentSessionAttachmentStore')
    .mockReturnValue(new AgentSessionAttachmentStore(dir, { hasSession: () => true }))
  try {
    const post = {
      ...original,
      msg_type: 'post',
      body: {
        content: JSON.stringify({
          title: 'Verified caption',
          content: [
            [
              { tag: 'img', image_key: 'img_first' },
              { tag: 'img', image_key: 'img_second' }
            ]
          ]
        })
      }
    }
    const raw = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64'
    )
    const api = {
      original: async () => [post],
      download: vi.fn(async (_mid: string, key: string) => {
        if (key === 'img_second') {
          throw new Error('Unavailable')
        }
        return raw
      })
    }
    const row: { mid: string; kind: 'post'; body: string; path: string | null } = {
      mid: post.message_id,
      kind: 'post',
      body: 'post',
      path: null
    }
    const stored = async (_account: string, _mid: string, path: string) => {
      row.path = path
    }
    await feishuInput(api, { stored }, verified, row, 'text-only', new AbortController().signal)
    expect(api.download).not.toHaveBeenCalled()
    const read = await feishuInput(
      api,
      { stored },
      verified,
      row,
      'codex',
      new AbortController().signal
    )
    expect(read.prompt).toContain('Verified caption')
    expect(read.prompt).toContain('inline image(s) 2')
    expect(read.storedImages).toHaveLength(1)
  } finally {
    current.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})
