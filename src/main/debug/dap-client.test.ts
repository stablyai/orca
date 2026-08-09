import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DapClient, type DapRequestMessage, type DapResponseMessage } from './dap-client'
import { DapMessageDecoder, encodeDapMessage } from './dap-message-framing'

function makeHarness(): {
  client: DapClient
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  sentRequests: DapRequestMessage[]
  respond: (request: DapRequestMessage, body?: unknown, success?: boolean) => void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const sentRequests: DapRequestMessage[] = []
  const stdinDecoder = new DapMessageDecoder()
  stdinDecoder.on('message', (msg) => sentRequests.push(msg as DapRequestMessage))
  stdin.on('data', (chunk: Buffer) => stdinDecoder.push(chunk))

  const client = new DapClient(stdin, stdout, stderr)

  const respond = (request: DapRequestMessage, body?: unknown, success = true): void => {
    const response: DapResponseMessage = {
      seq: request.seq + 1000,
      type: 'response',
      request_seq: request.seq,
      success,
      command: request.command,
      body
    }
    stdout.write(encodeDapMessage(response))
  }

  return { client, stdin, stdout, stderr, sentRequests, respond }
}

describe('DapClient', () => {
  it('resolves a request with the response body on success', async () => {
    const { client, sentRequests, respond } = makeHarness()
    const pending = client.request('initialize', { adapterID: 'node' })
    await waitForRequests(sentRequests)
    respond(sentRequests[0]!, { supportsConfigurationDoneRequest: true })
    await expect(pending).resolves.toEqual({ supportsConfigurationDoneRequest: true })
  })

  it('rejects a request when the response reports success: false', async () => {
    const { client, sentRequests, respond } = makeHarness()
    const pending = client.request('launch')
    await waitForRequests(sentRequests)
    respond(sentRequests[0]!, undefined, false)
    await expect(pending).rejects.toThrow(/failed/)
  })

  it('assigns increasing seq numbers per request', async () => {
    const { client, sentRequests, respond } = makeHarness()
    const first = client.request('initialize')
    await waitForRequests(sentRequests, 1)
    const second = client.request('launch')
    await waitForRequests(sentRequests, 2)
    expect(sentRequests[0]!.seq).toBe(1)
    expect(sentRequests[1]!.seq).toBe(2)
    respond(sentRequests[0]!)
    respond(sentRequests[1]!)
    await Promise.all([first, second])
  })

  it('re-emits adapter events with the event name and body', async () => {
    const { client, stdout } = makeHarness()
    const events: unknown[] = []
    client.on('event', (msg) => events.push(msg))
    stdout.write(
      encodeDapMessage({ seq: 1, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } })
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual([
      { seq: 1, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } }
    ])
  })

  it('rejects pending requests and further sends once the transport closes', async () => {
    const { client, stdout, sentRequests } = makeHarness()
    const pending = client.request('initialize')
    await waitForRequests(sentRequests)
    stdout.end()
    await expect(pending).rejects.toThrow(/closed/)
    await expect(client.request('launch')).rejects.toThrow(/closed/)
  })

  it('auto-acknowledges a reverse request with no listener so the adapter is never left hanging', async () => {
    const { client, stdin, stdout } = makeHarness()
    const acked = new Promise<DapResponseMessage>((resolve) => {
      const decoder = new DapMessageDecoder()
      decoder.on('message', (msg) => resolve(msg as DapResponseMessage))
      stdin.on('data', (chunk: Buffer) => decoder.push(chunk))
    })
    stdout.write(
      encodeDapMessage({ seq: 7, type: 'request', command: 'runInTerminal', arguments: {} })
    )
    const response = await acked
    expect(response).toMatchObject({ type: 'response', request_seq: 7, success: true })
    client.close()
  })

  it('emits reverseRequest and lets a listener control the acknowledgement', async () => {
    const { client, stdin, stdout } = makeHarness()
    const seen: unknown[] = []
    client.on('reverseRequest', (msg, respond) => {
      seen.push(msg)
      respond({ ok: true }, true)
    })
    const acked = new Promise<DapResponseMessage>((resolve) => {
      const decoder = new DapMessageDecoder()
      decoder.on('message', (msg) => resolve(msg as DapResponseMessage))
      stdin.on('data', (chunk: Buffer) => decoder.push(chunk))
    })
    stdout.write(
      encodeDapMessage({
        seq: 9,
        type: 'request',
        command: 'startDebugging',
        arguments: { request: 'launch', configuration: {} }
      })
    )
    const response = await acked
    expect(seen).toHaveLength(1)
    expect(response).toMatchObject({ request_seq: 9, success: true, body: { ok: true } })
    client.close()
  })
})

async function waitForRequests(sink: unknown[], count = 1): Promise<void> {
  for (let attempt = 0; attempt < 50 && sink.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
