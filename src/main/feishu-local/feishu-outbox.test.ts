import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import { closeBotsDbStores, handleBotsDbRequest } from '../bots/db-worker/bots-db-worker-entry'
import { inProcessWorker } from '../worker-threads/in-process-worker.test-fixture'
import { dmKey, type Binding } from './feishu-binding'
import type { FeishuTransport } from './feishu-transport'
import { FeishuReplyTargetGone, FeishuUploadPermissionError } from './feishu-transport'
import { drainFeishuOutbox } from './feishu-outbox'
import { feishuStore, type FeishuStore } from './feishu-store-ops'

let client: BotsDbWorkerClient, inbox: FeishuStore, binding: Binding
let owed: JournalConnectorReplyRow[]
const changed = vi.fn()
const api = { reply: vi.fn<FeishuTransport['reply']>(), upload: vi.fn<FeishuTransport['upload']>() }
beforeEach(async () => {
  client = new BotsDbWorkerClient(inProcessWorker(handleBotsDbRequest).factory)
  inbox = feishuStore(client, ':memory:')
  const b = await inbox.add('scope', 'bot', { appId: 'cli_demo', sealedSecret: 'sealed' })
  await inbox.pair('scope', b, {
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: 'ou_owner',
    chat_id: 'oc_private',
    message_id: 'om_pair',
    event_id: 'pair',
    create_time: '1800000000000',
    content: 'pair'
  })
  ;[binding] = await inbox.bindings('scope')
  api.reply.mockReset().mockResolvedValue(undefined)
  api.upload.mockReset().mockResolvedValue('file_fixture')
  owed = []
  changed.mockClear()
})
afterEach(() => {
  client.dispose()
  closeBotsDbStores()
  vi.restoreAllMocks()
})
async function admit(mid: string, outcome: 'answered' | 'no_answer' | 'failed' = 'answered') {
  await inbox.accept(binding, {
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: 'ou_owner',
    chat_id: 'oc_private',
    message_id: mid,
    event_id: `e_${mid}`,
    create_time: '1800000000001',
    content: 'synthetic'
  })
  owed.push({
    account: binding.account,
    conversation: dmKey(binding),
    deliveryId: mid,
    sessionId: 'session',
    epoch: 'one',
    messageId: mid,
    queued: false,
    fill: { outcome, answerDeliveryId: mid, filledAt: 1 }
  })
}
const drain = (beforeSettle: (mid: string) => void = () => {}) =>
  drainFeishuOutbox(
    api,
    {
      readOwed: async (_, after, limit) =>
        owed.filter((r) => after === null || r.deliveryId > after).slice(0, limit),
      sent: async (keys) => {
        beforeSettle(keys[0].deliveryId)
        owed = owed.filter(
          (r) => !keys.some((k) => k.account === r.account && k.deliveryId === r.deliveryId)
        )
      }
    },
    inbox,
    binding,
    new AbortController().signal,
    () => true,
    changed
  )

it.each(['upload', 'file reply'])(
  'stops further posts if the retry window expires during the %s',
  async (phase) => {
    await admit('om_target')
    await inbox.stageFile(binding.account, 'om_target', 'receipt.txt', Buffer.from('one'))
    let time = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    await inbox.postWindowStart(binding.account, 'om_target', time)
    const calls: string[] = []
    const record = (part: string) => {
      calls.push(part)
      if (part === phase) {
        time += 55 * 60_000
      }
    }
    api.upload.mockImplementation(async () => {
      record('upload')
      return 'file_fixture'
    })
    api.reply.mockImplementation(async () => record('file reply'))
    await drain()
    await drain()
    expect(calls).toEqual(phase === 'upload' ? ['upload'] : ['upload', 'file reply'])
    expect(owed).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await inbox.needsReview(binding.account)).toBe(true)
    expect(await inbox.artifact(binding.account, 'om_target')).toMatchObject({
      key: 'file_fixture',
      posted: phase === 'upload' ? 0 : 1
    })
  }
)
it('delivers a file-only success once and settles the original without a no-answer fallback', async () => {
  await admit('om_target', 'no_answer')
  await inbox.stageFile(binding.account, 'om_target', 'receipt.txt', Buffer.from('one'))
  await drain()
  await drain()
  expect(api.upload).toHaveBeenCalledOnce()
  expect(api.reply).toHaveBeenCalledOnce()
  expect(api.reply.mock.calls[0][0]).toBe('om_target')
  expect(api.reply.mock.calls[0][2]).toEqual({
    type: 'file',
    content: { file_key: 'file_fixture' }
  })
  expect(owed).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})
it('retires a recalled original and retries only the transient failure after delivering later rows', async () => {
  for (const mid of ['om_a', 'om_b', 'om_c']) {
    await admit(mid)
  }
  const sent = api.reply
    .mockRejectedValueOnce(new FeishuReplyTargetGone())
    .mockRejectedValueOnce(new Error('Temporary error'))
    .mockResolvedValue(undefined)
  await expect(drain()).rejects.toThrow('another attempt')
  expect(owed.map((r) => r.deliveryId)).toEqual(['om_b'])
  await drain()
  expect(owed).toEqual([])
  expect(sent.mock.calls.map(([mid]) => mid)).toEqual(['om_a', 'om_b', 'om_c', 'om_b'])
  expect(sent.mock.calls[1][3]).toBe(sent.mock.calls[3][3])
  expect(changed).toHaveBeenCalledTimes(1)
})

it('opens the first POST window only after the upload succeeds', async () => {
  await admit('om_a', 'no_answer')
  await inbox.stageFile(binding.account, 'om_a', 'demo.txt', Buffer.from('one'))
  let time = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => time)
  api.upload.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => {
    time += 60 * 60_000
    return 'file_fixture'
  })
  await expect(drain()).rejects.toThrow('another attempt')
  expect((await inbox.replyState(binding.account, 'om_a'))?.firstPost).toBeNull()
  await drain()
  expect(api.reply).toHaveBeenCalledOnce()
  expect(await inbox.replyState(binding.account, 'om_a')).toMatchObject({
    firstPost: time,
    done: true,
    review: false
  })
})
it('settles an already-confirmed file-only reply after restart even if its window has closed', async () => {
  await admit('om_a', 'no_answer')
  await inbox.stageFile(binding.account, 'om_a', 'one.txt', Buffer.from('a'))
  await inbox.uploaded(binding.account, 'om_a', 'file_one')
  await inbox.postWindowStart(binding.account, 'om_a', 1)
  await inbox.filePosted(binding.account, 'om_a')
  const send = api.reply
  await drain()
  expect(send).not.toHaveBeenCalled()
  expect(owed).toEqual([])
  expect(await inbox.needsReview(binding.account)).toBe(false)
})
it('retains a failed turn’s file across a transient reply error and clears the bytes on settlement', async () => {
  await admit('om_a', 'failed')
  await inbox.stageFile(binding.account, 'om_a', 'one.txt', Buffer.from('a'))
  const send = api.reply
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(undefined)
  await expect(drain()).rejects.toThrow('another attempt')
  expect((await inbox.artifact(binding.account, 'om_a'))?.bytes).toBeInstanceOf(Uint8Array)
  await drain()
  expect(send).toHaveBeenCalledTimes(2)
  expect(await inbox.artifact(binding.account, 'om_a')).toBeUndefined()
  await expect(
    inbox.stageFile(binding.account, 'om_a', 'two.txt', Buffer.from('b'))
  ).rejects.toThrow()
  expect(owed).toEqual([])
})
it('keeps a failed checkpoint owed without blocking other rows or resending a settled reply', async () => {
  for (const mid of ['om_a', 'om_b', 'om_c']) {
    await admit(mid)
  }
  const send = api.reply
    .mockRejectedValueOnce(new FeishuReplyTargetGone())
    .mockResolvedValue(undefined)
  vi.spyOn(inbox, 'finishReply').mockRejectedValueOnce(new Error('review checkpoint unavailable'))
  await expect(
    drain((mid) => {
      if (mid === 'om_b') {
        throw new Error('journal unavailable')
      }
    })
  ).rejects.toThrow('another attempt')
  expect(owed.map((r) => r.deliveryId)).toEqual(['om_a', 'om_b'])
  expect((await inbox.replyState(binding.account, 'om_b'))?.done).toBe(true)
  send.mockRejectedValueOnce(new FeishuReplyTargetGone())
  await drain()
  expect(owed).toEqual([])
  expect(send.mock.calls.map(([mid]) => mid)).toEqual(['om_a', 'om_b', 'om_c', 'om_a'])
  expect(changed).toHaveBeenCalledTimes(1)
})

it('keeps a denied tenant upload owed until the app permission is published', async () => {
  await admit('om_upload')
  await inbox.stageFile(binding.account, 'om_upload', 'receipt.txt', Buffer.from('synthetic'))
  api.upload.mockRejectedValueOnce(new FeishuUploadPermissionError())
  await expect(drain()).rejects.toBeInstanceOf(FeishuUploadPermissionError)
  expect(owed).toHaveLength(1)
  expect(api.reply).not.toHaveBeenCalled()
  await drain()
  expect(owed).toHaveLength(0)
  expect(api.reply.mock.calls[0][0]).toBe('om_upload')
})
