import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../../mobile-web-shell/test-support/bridge-host-test-fakes'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { copyPhoneWebhookUrl } from './mobile-webhook-url-copy'

const HOOK = 'wh_PhoneCopyTest001'
const URL = `https://connector.orca.dev/hooks/${HOOK}/secret-key`

function clipboard(): { written: string[]; writeText: (value: string) => Promise<void> } {
  const written: string[] = []
  return { written, writeText: async (value) => void written.push(value) }
}

async function answered(
  what: 'url' | 'key',
  reply: RpcResponse,
  wanted: () => boolean = () => true
): Promise<{ result: unknown; written: string[]; method: string | undefined }> {
  const client = createFakeRpcClient()
  const board = clipboard()
  const copying = copyPhoneWebhookUrl(client, HOOK, board, wanted, what)
  await Promise.resolve()
  client.requests[0]?.resolve(reply)
  return { result: await copying, written: board.written, method: client.requests[0]?.method }
}

describe('copyPhoneWebhookUrl', () => {
  const key: RpcResponse = { id: 'rpc-1', ok: true, result: { url: URL, key: 'secret-key' } }

  it('copies the key-bearing URL the host reveals, or the key alone', async () => {
    const url = await answered('url', key)
    expect(url).toEqual({ result: { kind: 'copied' }, written: [URL], method: 'webhooks.reveal' })
    expect((await answered('key', key)).written).toEqual(['secret-key'])
  })

  it('copies nothing when the host refuses or the caller stopped wanting it', async () => {
    const refused = await answered('url', {
      id: 'rpc-1',
      ok: false,
      error: { code: 'webhook_not_found', message: 'gone' }
    })
    expect(refused).toMatchObject({
      result: { kind: 'refused', code: 'webhook_not_found' },
      written: []
    })
    const dropped = await answered('url', key, () => false)
    expect(dropped).toMatchObject({ result: { kind: 'dropped' }, written: [] })
  })
})
