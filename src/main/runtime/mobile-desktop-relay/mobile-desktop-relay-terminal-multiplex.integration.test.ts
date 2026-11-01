import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import { RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import { readRuntimeMetadata } from '../runtime-metadata'
import { sendRequest } from '../runtime-rpc-test-harness'
import {
  capabilitiesOf,
  createRelayTopology,
  errorCode,
  type Frame,
  type Phone,
  WORKTREE
} from './relay-topology.test-fixture'
import type * as PassthroughSocketModule from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'

const passthroughOpens = vi.hoisted(() => {
  const hostReplies: string[] = []
  return { count: 0, hostReplies }
})
vi.mock(
  '../../../shared/remote-runtime/remote-runtime-passthrough-socket',
  async (importOriginal) => {
    const original = await importOriginal<typeof PassthroughSocketModule>()
    return {
      ...original,
      openRemoteRuntimePassthroughSocket: (
        ...[pairing, capabilities, callbacks, options]: Parameters<
          typeof original.openRemoteRuntimePassthroughSocket
        >
      ) => {
        passthroughOpens.count += 1
        return original.openRemoteRuntimePassthroughSocket(
          pairing,
          capabilities,
          {
            ...callbacks,
            onText: (plaintext) => {
              passthroughOpens.hostReplies.push(plaintext)
              callbacks.onText(plaintext)
            }
          },
          options
        )
      }
    }
  }
)

vi.mock('../../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('mobile desktop relay: relayed terminal multiplex', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  const { startTopology, connectPhone } = createRelayTopology(cleanups)

  // A client-chosen id no allocator on either computer would produce, so any renumbering shows.
  const CLIENT_STREAM = 4242
  const MULTIPLEX_CLIENT = [RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY]
  const streamFrame = (opcode: TerminalStreamOpcode, streamId: number, payload: Uint8Array) =>
    encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload })
  const subscribeFrame = (handle: string) =>
    streamFrame(
      TerminalStreamOpcode.Subscribe,
      0,
      encodeTerminalStreamJson({
        streamId: CLIENT_STREAM,
        terminal: handle,
        client: { id: 'desktop:tab:leaf:relayed', type: 'desktop' },
        viewport: { cols: 80, rows: 24 }
      })
    )
  const inputFrame = (text: string) =>
    streamFrame(TerminalStreamOpcode.Input, CLIENT_STREAM, new TextEncoder().encode(text))
  const outputOn = (client: Phone, streamId: number, text: string) =>
    client.binaries.some((bytes) => {
      const frame = decodeTerminalStreamFrame(bytes)
      return frame?.streamId === streamId && new TextDecoder().decode(frame.payload).includes(text)
    })
  const isReady = (frame: Frame) =>
    z.object({ result: z.object({ type: z.literal('ready') }) }).safeParse(frame).success

  it("relays a negotiated client's terminal multiplex with its own stream ids, both ways", async () => {
    const { host, desktop, handle } = await startTopology()
    const client = await connectPhone(desktop.server, 'Laptop', 'runtime', MULTIPLEX_CLIENT)
    client.send('status', 'status.get', {}, null)
    expect(capabilitiesOf(await client.next('status'))).toContain(
      RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
    )

    client.send('multiplex', 'terminal.multiplex', {})
    await client.next('multiplex', isReady)
    client.sendBinary(subscribeFrame(handle))
    // The server answers on the client's id, so the subscribe reached it unrenumbered.
    await client.next(
      'multiplex',
      (frame) =>
        z.object({ result: z.object({ streamId: z.literal(CLIENT_STREAM) }) }).safeParse(frame)
          .success
    )
    await vi.waitFor(() =>
      expect(
        client.binaries.some(
          (bytes) =>
            decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotEnd &&
            decodeTerminalStreamFrame(bytes)?.streamId === CLIENT_STREAM
        )
      ).toBe(true)
    )
    host.runtime.onPtyData('pty-shared', 'relayed-output', Date.now())
    await vi.waitFor(() => expect(outputOn(client, CLIENT_STREAM, 'relayed-output')).toBe(true))

    client.sendBinary(inputFrame('whoami'))
    await vi.waitFor(() => expect(host.writes).toContain('whoami'))
    // One connection carries one relayed multiplex, local or relayed, and phones never get one.
    client.send('second', 'terminal.multiplex', {})
    expect(errorCode(await client.next('second'))).toBe('forbidden')
    client.send('local', 'terminal.multiplex', {}, null)
    expect(await client.next('local')).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: 'binary_handler_mode_conflict' }
    })
    const phone = await connectPhone(desktop.server, 'iPhone', 'mobile', MULTIPLEX_CLIENT)
    phone.send('multiplex', 'terminal.multiplex', {})
    expect(errorCode(await phone.next('multiplex'))).toBe('forbidden')
  })

  it('keeps refusing a relayed multiplex to a client that never declared the capability', async () => {
    const { desktop } = await startTopology()
    const client = await connectPhone(desktop.server, 'Laptop', 'runtime')
    const opensBefore = passthroughOpens.count

    client.send('multiplex', 'terminal.multiplex', {})
    expect(errorCode(await client.next('multiplex'))).toBe('forbidden')
    expect(passthroughOpens.count).toBe(opensBefore)
  })

  it('reports a revoked multiplex as unavailable, and a fresh one after the next sync carries input', async () => {
    const { host, desktop, children, state, handle } = await startTopology()
    const client = await connectPhone(desktop.server, 'Laptop', 'runtime', MULTIPLEX_CLIENT)
    client.send('multiplex', 'terminal.multiplex', {})
    await client.next('multiplex', isReady)

    await host.server.revokeMobileDevice(children()[0]!.deviceId)
    expect(errorCode(await client.next('multiplex', (frame) => frame.ok === false))).toBe(
      'remote_runtime_unavailable'
    )
    state.retire('env-1')
    client.send('again', 'terminal.multiplex', {})
    await client.next('again', isReady)
    client.sendBinary(subscribeFrame(handle))
    client.sendBinary(inputFrame('after-drop'))
    await vi.waitFor(() => expect(host.writes).toContain('after-drop'))
  })

  it('keeps an untargeted multiplex local on a connection no relayed multiplex owns', async () => {
    const { host, desktop } = await startTopology()
    const metadata = readRuntimeMetadata(desktop.userDataPath)!
    const created = await sendRequest(metadata.transports[0]!.endpoint, {
      id: 'create-local',
      authToken: metadata.authToken,
      method: 'terminal.create',
      params: {
        worktree: WORKTREE,
        command: 'bash',
        tabId: 'tab-local',
        leafId: '33333333-3333-4333-8333-333333333333',
        activate: true
      }
    })
    const local = z.object({ terminal: z.object({ handle: z.string() }) }).parse(created.result)
    const client = await connectPhone(desktop.server, 'Laptop', 'runtime', MULTIPLEX_CLIENT)
    const opensBefore = passthroughOpens.count

    client.send('multiplex', 'terminal.multiplex', {}, null)
    await client.next('multiplex', isReady)
    client.sendBinary(subscribeFrame(local.terminal.handle))
    client.sendBinary(inputFrame('stays-here'))
    await vi.waitFor(() => expect(desktop.writes).toContain('stays-here'))
    expect(host.writes).not.toContain('stays-here')
    expect(passthroughOpens.count).toBe(opensBefore)
    // A relayed multiplex would take this connection's binary frames from its local streams.
    client.send('relayed', 'terminal.multiplex', {})
    expect(errorCode(await client.next('relayed'))).toBe('forbidden')
  })
})
