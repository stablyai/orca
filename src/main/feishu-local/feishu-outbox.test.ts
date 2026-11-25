import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import { closeBotsDbStores, handleBotsDbRequest } from '../bots/db-worker/bots-db-worker-entry'
import { inProcessWorker } from '../worker-threads/in-process-worker.test-fixture'
import { dmKey, type Binding } from './feishu-binding'
import * as cli from './feishu-cli'
import { drainFeishuOutbox } from './feishu-outbox'
import { feishuStore, type FeishuStore } from './feishu-store-ops'

let client: BotsDbWorkerClient, inbox: FeishuStore, binding: Binding
let owed: JournalConnectorReplyRow[]
const changed = vi.fn()
const receipt = {
  ok: true,
  identity: 'bot',
  data: { chat_id: 'oc_private', message_id: 'om_reply' }
}
const upload = { ok: true, identity: 'bot', data: { file_key: 'file_fixture' } }
beforeEach(async () => {
  client = new BotsDbWorkerClient(inProcessWorker(handleBotsDbRequest).factory)
  inbox = feishuStore(client, ':memory:')
  const b = await inbox.add('scope', 'bot', { name: 'fixture', appId: 'cli_demo', brand: 'feishu' })
  await inbox.pair('scope', b, {
    type: 'im.message.receive_v1',
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
    type: 'im.message.receive_v1',
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
const drain = (
  checkProfile: () => Promise<void> = async () => {},
  beforeSettle: (mid: string) => void = () => {}
) =>
  drainFeishuOutbox(
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
    checkProfile,
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
    vi.spyOn(cli, 'feishuCommand').mockImplementation(async (args) => {
      const part = args.includes('/open-apis/im/v1/files') ? 'upload' : 'file reply'
      calls.push(part)
      if (part === phase) {
        time += 55 * 60_000
      }
      return part === 'upload' ? upload : receipt
    })
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
  const sent = vi
    .spyOn(cli, 'feishuCommand')
    .mockResolvedValueOnce(upload)
    .mockResolvedValueOnce(receipt)
  await drain()
  await drain()
  expect(sent).toHaveBeenCalledTimes(2)
  expect(sent.mock.calls[1][0]).toContain('/open-apis/im/v1/messages/om_target/reply')
  expect(sent.mock.calls[1][2]).toContain('"msg_type":"file"')
  expect(owed).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})
it('retires a recalled original and retries only the transient failure after delivering later rows', async () => {
  for (const mid of ['om_a', 'om_b', 'om_c']) {
    await admit(mid)
  }
  const sent = vi
    .spyOn(cli, 'feishuCommand')
    .mockRejectedValueOnce(new cli.FeishuReplyTargetGone())
    .mockRejectedValueOnce(new Error('Temporary error'))
    .mockResolvedValue(receipt)
  await expect(drain()).rejects.toThrow('another attempt')
  expect(owed.map((r) => r.deliveryId)).toEqual(['om_b'])
  await drain()
  expect(owed).toEqual([])
  expect(
    sent.mock.calls.map((c) =>
      c[0]
        .find((s) => s.endsWith('/reply'))
        ?.split('/')
        .at(-2)
    )
  ).toEqual(['om_a', 'om_b', 'om_c', 'om_b'])
  expect(changed).toHaveBeenCalledTimes(1)
})

it('opens the first POST window only after a profile outage and upload complete', async () => {
  await admit('om_a', 'no_answer')
  await inbox.stageFile(binding.account, 'om_a', 'demo.txt', Buffer.from('one'))
  let time = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => time)
  await expect(
    drain(async () => {
      throw new Error('offline')
    })
  ).rejects.toThrow('another attempt')
  expect((await inbox.replyState(binding.account, 'om_a'))?.firstPost).toBeNull()
  time += 60 * 60_000
  const send = vi
    .spyOn(cli, 'feishuCommand')
    .mockImplementationOnce(async () => {
      time += 60 * 60_000
      return upload
    })
    .mockResolvedValue(receipt)
  await drain()
  expect(send).toHaveBeenCalledTimes(2)
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
  const send = vi.spyOn(cli, 'feishuCommand')
  await drain()
  expect(send).not.toHaveBeenCalled()
  expect(owed).toEqual([])
  expect(await inbox.needsReview(binding.account)).toBe(false)
})
it('retains a failed turn’s file across a transient reply error and clears the bytes on settlement', async () => {
  await admit('om_a', 'failed')
  await inbox.stageFile(binding.account, 'om_a', 'one.txt', Buffer.from('a'))
  const send = vi
    .spyOn(cli, 'feishuCommand')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(receipt)
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
  const send = vi
    .spyOn(cli, 'feishuCommand')
    .mockRejectedValueOnce(new cli.FeishuReplyTargetGone())
    .mockResolvedValue(receipt)
  vi.spyOn(inbox, 'finishReply').mockRejectedValueOnce(new Error('review checkpoint unavailable'))
  await expect(
    drain(undefined, (mid) => {
      if (mid === 'om_b') {
        throw new Error('journal unavailable')
      }
    })
  ).rejects.toThrow('another attempt')
  expect(owed.map((r) => r.deliveryId)).toEqual(['om_a', 'om_b'])
  expect((await inbox.replyState(binding.account, 'om_b'))?.done).toBe(true)
  send.mockRejectedValueOnce(new cli.FeishuReplyTargetGone())
  await drain()
  expect(owed).toEqual([])
  expect(
    send.mock.calls.map((c) =>
      c[0]
        .find((s) => s.endsWith('/reply'))
        ?.split('/')
        .at(-2)
    )
  ).toEqual(['om_a', 'om_b', 'om_c', 'om_a'])
  expect(changed).toHaveBeenCalledTimes(1)
})
