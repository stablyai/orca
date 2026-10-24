import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { attachMobileImageToTerminal } from './mobile-image-attachment'

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
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
  it.each([null, 'unknown', 'codex'])(
    'uploads an image as an attachment path when terminal agent is %s',
    async (agent) => {
      const client = clientWithResponses([
        ok('start', { uploadId: 'upload-1' }),
        ok('append', { received: 4 }),
        ok('commit', '/tmp/codex-shot.png'),
        ok('send', { send: { accepted: true } })
      ])

      expect(
        await attachMobileImageToTerminal('library', {
          client,
          agent,
          terminal: 'codex-term',
          deviceToken: null,
          getConnectionId: async () => 'connection-ssh',
          pickImage: async () => ({ base64: 'AAAA' })
        })
      ).toBe(true)
      expect(
        client.calls.find((call) => call.method === 'clipboard.startImageUpload')?.params
      ).toMatchObject({ connectionId: 'connection-ssh' })
      expect(client.calls.at(-1)).toEqual({
        method: 'terminal.send',
        params: {
          terminal: 'codex-term',
          text: '\x1b[200~/tmp/codex-shot.png\x1b[201~ ',
          enter: false
        }
      })
    }
  )

  it('keeps the captured OMP format while the picker is pending', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/my image.png'),
      ok('send', { send: { accepted: true } })
    ])
    let resolvePick!: (value: { base64: string }[]) => void
    const deps = {
      client,
      terminal: 'omp-term',
      agent: 'omp',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImages: () =>
        new Promise<{ base64: string }[]>((resolve) => {
          resolvePick = resolve
        })
    }
    const pending = attachMobileImageToTerminal('library', deps)
    deps.agent = 'claude'
    deps.terminal = 'other-term'
    resolvePick([{ base64: 'AAAA' }])
    expect(await pending).toBe(true)
    expect(client.calls.find((call) => call.method === 'terminal.send')?.params).toMatchObject({
      terminal: 'omp-term',
      text: '\x1b[200~@"/tmp/my image.png"\x1b[201~ ',
      enter: false
    })
  })

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
      ok('send', { send: { accepted: true } })
    ])

    const sent = await attachMobileImageToTerminal('library', {
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: 'device-9',
      getConnectionId: async () => 'conn-7',
      pickImages: vi.fn().mockResolvedValue([{ base64: 'AAAA' }])
    })

    expect(sent).toBe(true)
    const sendCall = client.calls.find((c) => c.method === 'terminal.send')
    expect(sendCall?.params).toEqual({
      terminal: 'term-1',
      // Trailing space: the user types on this same line next, so a bare
      // `…\x1b[201~` would arrive as `…pngadd` (STA-4847).
      text: '\x1b[200~/tmp/orca-attach.png\x1b[201~ ',
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
      ok('send', { send: { accepted: true } })
    ])

    await attachMobileImageToTerminal('files', {
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      getConnectionId: async () => 'conn-ssh',
      pickImages: vi.fn().mockResolvedValue([{ base64: 'BBBB' }])
    })

    const saveCall = client.calls.find((c) => c.method === 'clipboard.saveImageAsTempFile')
    expect(saveCall?.params).toMatchObject({ connectionId: 'conn-ssh' })
  })

  it('does nothing and returns false when the picker is cancelled', async () => {
    const client = clientWithResponses([])

    const sent = await attachMobileImageToTerminal('library', {
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([])
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
      ok('send', { send: { accepted: true } })
    ])

    await attachMobileImageToTerminal('library', {
      client,
      agent: 'claude',
      terminal: 'term-2',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([{ base64: 'CCCC' }])
    })

    const sendCall = client.calls.find((c) => c.method === 'terminal.send')
    expect(sendCall?.params).not.toHaveProperty('client')
  })

  it('drops the image payload when the final pre-send check observes an input lease gap', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/pending.png')
    ])
    // Why: upload can outlive the stream subscription whose acknowledgement
    // originally enabled the composer.
    const beforeTerminalSend = vi.fn(async () => false)

    const sent = await attachMobileImageToTerminal('library', {
      client,
      agent: 'claude',
      terminal: 'term-pending',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([{ base64: 'DDDD' }]),
      beforeTerminalSend
    })

    expect(sent).toBe(false)
    expect(beforeTerminalSend).toHaveBeenCalledWith('term-pending')
    expect(client.calls.some((call) => call.method === 'terminal.send')).toBe(false)
  })

  it('reports failure when the terminal rejects the uploaded image path', async () => {
    const client = clientWithResponses([
      {
        id: 'start',
        ok: false,
        error: { code: 'method_not_found', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok('save', '/tmp/rejected.png'),
      ok('send', { send: { accepted: false } })
    ])

    const sent = await attachMobileImageToTerminal('library', {
      client,
      agent: 'claude',
      terminal: 'term-rejected',
      deviceToken: null,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([{ base64: 'EEEE' }])
    })

    expect(sent).toBe(false)
  })

  describe('when several images are picked', () => {
    const noSlot = {
      id: 'start',
      ok: false,
      error: { code: 'method_not_found', message: 'no' },
      _meta: { runtimeId: 'r' }
    } as const

    function sendTexts(client: { calls: { method: string; params: unknown }[] }): string[] {
      return client.calls
        .filter((call) => call.method === 'terminal.send')
        .map((call) => {
          const params = call.params
          if (
            typeof params !== 'object' ||
            params === null ||
            !('text' in params) ||
            typeof params.text !== 'string'
          ) {
            throw new Error('Expected a terminal text payload')
          }
          return params.text
        })
    }

    it('uploads every image and pastes each path in pick order', async () => {
      const client = clientWithResponses([
        noSlot,
        ok('save-1', '/tmp/first.png'),
        { ...noSlot, id: 'start-2' },
        ok('save-2', '/tmp/second.png'),
        { ...noSlot, id: 'start-3' },
        ok('save-3', '/tmp/third.png'),
        ok('send-1', { send: { accepted: true } }),
        ok('send-2', { send: { accepted: true } }),
        ok('send-3', { send: { accepted: true } })
      ])
      const onUploadStart = vi.fn()

      const sent = await attachMobileImageToTerminal('library', {
        client,
        agent: 'codex',
        terminal: 'term-many',
        deviceToken: 'device-9',
        getConnectionId: async () => 'conn-7',
        pickImages: vi
          .fn()
          .mockResolvedValue([{ base64: 'AAAA' }, { base64: 'BBBB' }, { base64: 'CCCC' }]),
        onUploadStart
      })

      expect(sent).toBe(true)
      expect(onUploadStart).toHaveBeenCalledTimes(1)
      // Only the last paste is followed by a space; the others sit flush like desktop drops.
      expect(sendTexts(client)).toEqual([
        '\x1b[200~/tmp/first.png\x1b[201~',
        '\x1b[200~/tmp/second.png\x1b[201~',
        '\x1b[200~/tmp/third.png\x1b[201~ '
      ])
      expect(
        client.calls.filter((call) => call.method === 'terminal.send').map((call) => call.params)
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            terminal: 'term-many',
            enter: false,
            client: { id: 'device-9', type: 'mobile' }
          })
        ])
      )
    })

    it('reads a streamed selection and keeps going past the first image', async () => {
      const client = clientWithResponses([
        noSlot,
        ok('save-1', '/tmp/a.png'),
        { ...noSlot, id: 'start-2' },
        ok('save-2', '/tmp/b.png'),
        ok('send-1', { send: { accepted: true } }),
        ok('send-2', { send: { accepted: true } })
      ])
      async function* streamed(): AsyncGenerator<{ base64: string }> {
        yield { base64: 'AAAA' }
        yield { base64: 'BBBB' }
      }

      const sent = await attachMobileImageToTerminal('files', {
        client,
        agent: 'claude',
        terminal: 'term-stream',
        deviceToken: null,
        getConnectionId: async () => null,
        pickImages: () => streamed()
      })

      expect(sent).toBe(true)
      expect(sendTexts(client)).toHaveLength(2)
    })

    it('checks the input lease once before pasting the whole selection', async () => {
      const client = clientWithResponses([
        noSlot,
        ok('save-1', '/tmp/a.png'),
        { ...noSlot, id: 'start-2' },
        ok('save-2', '/tmp/b.png')
      ])
      const beforeTerminalSend = vi.fn(async () => false)

      const sent = await attachMobileImageToTerminal('library', {
        client,
        agent: 'claude',
        terminal: 'term-gap',
        deviceToken: null,
        getConnectionId: async () => null,
        pickImages: vi.fn().mockResolvedValue([{ base64: 'AAAA' }, { base64: 'BBBB' }]),
        beforeTerminalSend
      })

      expect(sent).toBe(false)
      expect(beforeTerminalSend).toHaveBeenCalledTimes(1)
      expect(sendTexts(client)).toEqual([])
    })

    it('stops pasting when the terminal rejects one of the images', async () => {
      const client = clientWithResponses([
        noSlot,
        ok('save-1', '/tmp/a.png'),
        { ...noSlot, id: 'start-2' },
        ok('save-2', '/tmp/b.png'),
        ok('send-1', { send: { accepted: false } })
      ])

      const sent = await attachMobileImageToTerminal('library', {
        client,
        agent: 'claude',
        terminal: 'term-reject',
        deviceToken: null,
        getConnectionId: async () => null,
        pickImages: vi.fn().mockResolvedValue([{ base64: 'AAAA' }, { base64: 'BBBB' }])
      })

      expect(sent).toBe(false)
      expect(sendTexts(client)).toHaveLength(1)
    })

    it('pastes the images that uploaded, then reports the failure of the one that did not', async () => {
      const client = clientWithResponses([
        noSlot,
        ok('save-1', '/tmp/kept.png'),
        { ...noSlot, id: 'start-2' },
        {
          id: 'save-2',
          ok: false,
          error: { code: 'boom', message: 'upload broke' },
          _meta: { runtimeId: 'r' }
        },
        ok('send-1', { send: { accepted: true } })
      ])

      await expect(
        attachMobileImageToTerminal('library', {
          client,
          agent: 'claude',
          terminal: 'term-partial',
          deviceToken: null,
          getConnectionId: async () => null,
          pickImages: vi.fn().mockResolvedValue([{ base64: 'AAAA' }, { base64: 'BBBB' }])
        })
      ).rejects.toThrow('upload broke')

      expect(sendTexts(client)).toEqual(['\x1b[200~/tmp/kept.png\x1b[201~ '])
    })

    it('rejects without touching the terminal when the first upload fails', async () => {
      const client = clientWithResponses([
        noSlot,
        {
          id: 'save',
          ok: false,
          error: { code: 'boom', message: 'upload broke' },
          _meta: { runtimeId: 'r' }
        }
      ])

      await expect(
        attachMobileImageToTerminal('library', {
          client,
          agent: 'claude',
          terminal: 'term-fail',
          deviceToken: null,
          getConnectionId: async () => null,
          pickImages: vi.fn().mockResolvedValue([{ base64: 'AAAA' }])
        })
      ).rejects.toThrow('upload broke')

      expect(sendTexts(client)).toEqual([])
    })
  })
})
