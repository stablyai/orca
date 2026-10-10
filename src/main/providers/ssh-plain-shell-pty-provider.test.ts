import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel, PseudoTtyOptions } from 'ssh2'
import { SshPlainShellPtyProvider } from './ssh-plain-shell-pty-provider'

class FakeShellChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly writes: string[] = []
  readonly setWindow = vi.fn()
  readonly signal = vi.fn()
  readonly close = vi.fn()
  write(data: string): boolean {
    this.writes.push(data)
    return true
  }
}

const MODE = { reason: 'no_runtime', message: 'No runtime here.' }

function createProvider(options: { posixHost?: boolean } = {}) {
  const channels: FakeShellChannel[] = []
  const opened: PseudoTtyOptions[] = []
  const provider = new SshPlainShellPtyProvider(
    'target-1',
    async (pty) => {
      opened.push(pty)
      const channel = new FakeShellChannel()
      channels.push(channel)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake implements every ClientChannel member the provider touches.
      return channel as unknown as ClientChannel
    },
    MODE,
    options.posixHost ?? true,
    7
  )
  const data: { id: string; data: string; providerGeneration: number }[] = []
  const exits: { id: string; code: number }[] = []
  provider.onData((payload) => data.push(payload))
  provider.onExit((payload) => exits.push(payload))
  return { provider, channels, opened, data, exits }
}

describe('SshPlainShellPtyProvider', () => {
  it('opens a pty-req shell at the requested size and shows the plain SSH reason', async () => {
    const { provider, channels, opened, data } = createProvider()
    const result = await provider.spawn({ cols: 120, rows: 40, cwd: "/srv/it's" })

    expect(opened).toEqual([{ cols: 120, rows: 40, term: 'xterm-256color' }])
    expect(result.id).toMatch(/^ssh:target-1@@plain-/)
    expect(result.incarnationId).toEqual(expect.any(String))
    expect(result.sessionExpired).toBeUndefined()
    expect(data[0]).toMatchObject({ id: result.id, providerGeneration: 7 })
    expect(data[0]?.data).toContain('No runtime here.')
    expect(channels[0]?.writes).toEqual([` cd -- '/srv/it'\\''s'\n`])
  })

  it('keeps a home-relative cwd expandable by leaving the tilde unquoted', async () => {
    const { provider, channels } = createProvider()
    await provider.spawn({ cols: 80, rows: 24, cwd: "~/it's" })
    await provider.spawn({ cols: 80, rows: 24, cwd: '~' })
    expect(channels[0]?.writes).toEqual([` cd -- ~/'it'\\''s'\n`])
    expect(channels[1]?.writes).toEqual([' cd -- ~\n'])
  })

  it('does not type a POSIX cd into a Windows host shell', async () => {
    const { provider, channels } = createProvider({ posixHost: false })
    await provider.spawn({ cols: 80, rows: 24, cwd: 'C:\\work' })
    expect(channels[0]?.writes).toEqual([])
  })

  it('forwards output, input and resize over the channel', async () => {
    const { provider, channels, data } = createProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const channel = channels[0]!

    // A multi-byte character split across chunks must not decode as replacement characters.
    const euro = Buffer.from('€', 'utf8')
    channel.emit('data', euro.subarray(0, 1))
    channel.emit('data', euro.subarray(1))
    channel.stderr.emit('data', Buffer.from('err'))
    expect(data.slice(1).map((d) => d.data)).toEqual(['€', 'err'])

    expect(provider.write(id, 'ls\r')).toBe(true)
    expect(provider.writeWithSettlement(id, 'x')).toEqual({ outcome: 'accepted' })
    expect(channel.writes).toEqual(['ls\r', 'x'])

    provider.resize(id, 100, 30)
    expect(channel.setWindow).toHaveBeenCalledWith(30, 100, 0, 0)
    await expect(provider.getAppliedSize(id)).resolves.toEqual({ cols: 100, rows: 30 })
  })

  it('reports exited only when the host sent an exit status', async () => {
    const { provider, channels, exits } = createProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    channels[0]!.emit('exit', 3)
    channels[0]!.emit('close')

    expect(exits).toEqual([expect.objectContaining({ id, code: 3, providerGeneration: 7 })])
    await expect(provider.probePtyLiveness(id)).resolves.toBe(false)
  })

  it('treats a close without an exit status as unverifiable, not exited', async () => {
    const { provider, channels, exits, data } = createProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    channels[0]!.emit('close')

    expect(exits).toEqual([])
    expect(data.at(-1)?.data).toContain('unverifiable')
    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
    expect(provider.writeWithSettlement(id, 'x')).toEqual({
      outcome: 'refused',
      reason: 'provider_unavailable'
    })
  })

  it('reports an operator close as an exit once the channel closes', async () => {
    const { provider, channels, exits } = createProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    await provider.shutdown(id)
    expect(channels[0]!.close).toHaveBeenCalled()
    channels[0]!.emit('close')
    expect(exits).toEqual([expect.objectContaining({ id, code: 0 })])
  })

  it('leaves open shells unverifiable when the transport is disposed', async () => {
    const { provider, channels, exits } = createProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    provider.dispose()
    channels[0]!.emit('close')

    expect(exits).toEqual([])
    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
    await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow('not active')
  })

  it('leaves a PTY it never minted unverifiable, since an earlier relay may still run it', async () => {
    const { provider } = createProvider()
    await expect(provider.probePtyLiveness('ssh:target-1@@prior-relay-pty')).resolves.toBeNull()
  })

  it('starts a fresh shell for a reattach request and says the session expired', async () => {
    const { provider } = createProvider()
    const result = await provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:target-1@@pty-3' })
    expect(result.sessionExpired).toBe(true)
  })

  it('refuses relay-only launches with the plain SSH reason', async () => {
    const { provider, opened } = createProvider()
    await expect(provider.spawn({ cols: 80, rows: 24, launchAgent: 'claude' })).rejects.toThrow(
      'needs the Orca remote server'
    )
    await expect(provider.spawn({ cols: 80, rows: 24, attachOnly: true })).rejects.toThrow(
      '(no_runtime)'
    )
    expect(opened).toEqual([])
  })
})
