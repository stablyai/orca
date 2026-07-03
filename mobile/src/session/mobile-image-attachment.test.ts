import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { attachMobileImageToTerminal } from './mobile-image-attachment'

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}

describe('attachMobileImageToTerminal', () => {
  it('uploads the picked image and pastes its bracketed path into the terminal', async () => {
    // startImageUpload (method_not_found) falls back to single-frame saveImageAsTempFile.
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/orca-attach.png'),
      ok('send', { ok: true })
    ])

    const sent = await attachMobileImageToTerminal('library', {
      client,
      terminal: 'term-1',
      deviceToken: 'device-9',
      getConnectionId: async () => 'conn-7',
      pickImage: vi.fn().mockResolvedValue({ base64: 'AAAA' })
    })

    expect(sent).toBe(true)
    const sendCall = client.calls.find((c) => c.method === 'terminal.send')
    expect(sendCall?.params).toEqual({
      terminal: 'term-1',
      text: '\x1b[200~/tmp/orca-attach.png\x1b[201~',
      enter: false,
      client: { id: 'device-9', type: 'mobile' }
    })
  })

  it('passes the active worktree connectionId to the upload', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/x.png'),
      ok('send', { ok: true })
    ])

    await attachMobileImageToTerminal('files', {
      client,
      terminal: 'term-1',
      deviceToken: null,
      getConnectionId: async () => 'conn-ssh',
      pickImage: vi.fn().mockResolvedValue({ base64: 'BBBB' })
    })

    const saveCall = client.calls.find((c) => c.method === 'clipboard.saveImageAsTempFile')
    expect(saveCall?.params).toMatchObject({ connectionId: 'conn-ssh' })
  })

  it('does nothing and returns false when the picker is cancelled', async () => {
    const client = clientWithResponses([])

    const sent = await attachMobileImageToTerminal('library', {
      client,
      terminal: 'term-1',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue(null)
    })

    expect(sent).toBe(false)
    expect(client.calls).toEqual([])
  })

  it('omits the client field when there is no device token', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/y.png'),
      ok('send', { ok: true })
    ])

    await attachMobileImageToTerminal('library', {
      client,
      terminal: 'term-2',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue({ base64: 'CCCC' })
    })

    const sendCall = client.calls.find((c) => c.method === 'terminal.send')
    expect(sendCall?.params).not.toHaveProperty('client')
  })

  it('waits for pending live input before sending the image payload', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/pending.png')
    ])
    const beforeTerminalSend = vi.fn(async () => false)

    const sent = await attachMobileImageToTerminal('library', {
      client,
      terminal: 'term-pending',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue({ base64: 'DDDD' }),
      beforeTerminalSend
    })

    expect(sent).toBe(false)
    expect(beforeTerminalSend).toHaveBeenCalledWith('term-pending')
    expect(client.calls.some((call) => call.method === 'terminal.send')).toBe(false)
  })
})
