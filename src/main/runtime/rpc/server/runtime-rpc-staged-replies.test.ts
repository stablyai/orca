import { describe, expect, it } from 'vitest'
import { RuntimeRpcStagedReplies } from './runtime-rpc-staged-replies'
import { readRuntimeRpcStagedReply } from '../../../../shared/remote-runtime/requests/runtime-rpc-staged-reply-read'
import { RUNTIME_RPC_STAGED_REPLY_PART_CHARS } from '../../../../shared/remote-runtime/rpc/runtime-rpc-staged-reply'

describe('staged RPC replies', () => {
  it('hands the asking device back the exact reply, and no other device', async () => {
    const replies = new RuntimeRpcStagedReplies(() => 'rt')
    // A surrogate pair straddles the first part boundary; quotes and escapes ride along.
    const reply = (data: string) => ({
      id: 'r1',
      ok: true as const,
      result: { data },
      _meta: { runtimeId: 'rt' }
    })
    const prefix = JSON.stringify(reply('')).indexOf('""') + 1
    const pad = 'a'.repeat(RUNTIME_RPC_STAGED_REPLY_PART_CHARS - 1 - prefix)
    const original = reply(`${pad}😀"\\\n${'b'.repeat(RUNTIME_RPC_STAGED_REPLY_PART_CHARS)}`)
    const text = JSON.stringify(original)
    expect(text.charCodeAt(RUNTIME_RPC_STAGED_REPLY_PART_CHARS - 1)).toBe(0xd83d)
    const handle = replies.stage('phone-a', text, Buffer.byteLength(text))!

    expect(replies.read('phone-b', handle.replyId, 0)).toBeNull()
    const staged = {
      id: 'r1',
      ok: false as const,
      error: { code: 'reply_staged', message: '', data: handle }
    }
    const read = await readRuntimeRpcStagedReply(staged, async ({ replyId, offset }) => {
      const part = replies.read('phone-a', replyId, offset)
      expect(part).not.toBeNull()
      expect(part!.isWellFormed()).toBe(true)
      return { id: 'p', ok: true, result: { text: part! }, _meta: { runtimeId: 'rt' } }
    })

    expect(read).toEqual(original)
    expect(replies.read('phone-a', handle.replyId, 0)).toBeNull()
  })
})
