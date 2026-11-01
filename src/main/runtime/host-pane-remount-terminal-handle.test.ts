import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'

const WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const TAB_ID = 'tab-hidden-on-host'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = `${WORKTREE_ID}@@aaaaaaaa`

type StreamFrame = NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>

function graph(ptyId: string | null, extraLeafPtyId?: string) {
  const leaves = [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId }
  ]
  const tabs = [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: 'T', activeLeafId: LEAF_ID, layout: null }
  ]
  if (extraLeafPtyId) {
    tabs.push({
      tabId: 'tab-2',
      worktreeId: WORKTREE_ID,
      title: 'T2',
      activeLeafId: 'pane:2',
      layout: null
    })
    leaves.push({
      tabId: 'tab-2',
      worktreeId: WORKTREE_ID,
      leafId: 'pane:2',
      paneRuntimeId: 2,
      ptyId: extraLeafPtyId
    })
  }
  return { tabs, leaves }
}

function makeHost(options: { livePtyIds: Set<string> }) {
  const writes: string[] = []
  const inputWritten = Promise.withResolvers<void>()
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: (_ptyId, data) => {
      writes.push(data)
      inputWritten.resolve()
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (ptyId) => options.livePtyIds.has(ptyId)
  })
  runtime.attachWindow(1)
  return { runtime, writes, inputWritten: inputWritten.promise }
}

async function handleFor(runtime: OrcaRuntimeService): Promise<string> {
  const listing = await runtime.listTerminals()
  return listing.terminals.find((terminal) => terminal.tabId === TAB_ID)!.handle
}

function startMultiplex(runtime: OrcaRuntimeService) {
  const binaryFrames: StreamFrame[] = []
  const controlRegistered = Promise.withResolvers<void>()
  const subscribed = Promise.withResolvers<void>()
  const writeUnavailable = Promise.withResolvers<void>()
  const handlers = new Map<number, (frame: StreamFrame) => void>()
  const messages: { result?: { type?: string; streamId?: number } }[] = []
  const request: RpcRequest = {
    id: 'req',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  void new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
    request,
    (message) => {
      messages.push(JSON.parse(message))
      if (messages.at(-1)?.result?.type === 'subscribed') {
        subscribed.resolve()
      }
    },
    {
      connectionId: 'paired-client',
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
        const frame = decodeTerminalStreamFrame(bytes)
        if (frame) {
          binaryFrames.push(frame)
          if (frame.opcode === TerminalStreamOpcode.WriteUnavailable) {
            writeUnavailable.resolve()
          }
        }
        return true
      },
      registerBinaryStreamHandler: (streamId: number, handler: (frame: StreamFrame) => void) => {
        handlers.set(streamId, handler)
        if (streamId === 0) {
          controlRegistered.resolve()
        }
        return () => handlers.delete(streamId)
      }
    }
  )
  const send = (streamId: number, opcode: TerminalStreamOpcode, payload: Uint8Array) =>
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload }))!
    )
  return {
    binaryFrames,
    handlers,
    messages,
    send,
    controlRegistered: controlRegistered.promise,
    subscribed: subscribed.promise,
    writeUnavailable: writeUnavailable.promise
  }
}

describe('a host pane remounting onto its same live PTY (#23759)', () => {
  it('keeps the handle a paired client is typing into', async () => {
    const { runtime, writes, inputWritten } = makeHost({ livePtyIds: new Set([PTY_ID]) })
    runtime.syncWindowGraph(1, graph(PTY_ID))
    const handle = await handleFor(runtime)

    const client = startMultiplex(runtime)
    await client.controlRegistered
    expect(client.handlers.has(0)).toBe(true)
    client.send(
      0,
      TerminalStreamOpcode.Subscribe,
      encodeTerminalStreamJson({
        streamId: 1,
        terminal: handle,
        client: { id: 'client-b', type: 'desktop' },
        capabilities: { writeUnavailable: 1 }
      })
    )
    await client.subscribed
    expect(client.messages.some((message) => message.result?.type === 'subscribed')).toBe(true)

    runtime.syncWindowGraph(1, graph(null))
    runtime.syncWindowGraph(1, graph(PTY_ID))
    expect(await handleFor(runtime)).toBe(handle)

    client.send(1, TerminalStreamOpcode.Input, encodeTerminalStreamText('ls\r'))
    await Promise.race([inputWritten, client.writeUnavailable])
    expect(writes).toEqual(['ls\r'])
    expect(
      client.binaryFrames.some((frame) => frame.opcode === TerminalStreamOpcode.WriteUnavailable)
    ).toBe(false)
  })

  it('accepts input sent while the remounting leaf has not reattached yet', async () => {
    const { runtime, writes } = makeHost({ livePtyIds: new Set([PTY_ID]) })
    runtime.syncWindowGraph(1, graph(PTY_ID))
    const handle = await handleFor(runtime)
    runtime.syncWindowGraph(1, graph(null))

    await runtime.sendTerminal(handle, { text: 'x' }, { inputKind: 'driving' })
    expect(writes).toEqual(['x'])
  })

  it('still drops a leaf whose PTY the host no longer has', async () => {
    const livePtyIds = new Set([PTY_ID])
    const { runtime } = makeHost({ livePtyIds })
    runtime.syncWindowGraph(1, graph(PTY_ID))
    const handle = await handleFor(runtime)
    livePtyIds.clear()
    runtime.syncWindowGraph(1, graph(null))

    await expect(
      runtime.sendTerminal(handle, { text: 'x' }, { inputKind: 'driving' })
    ).rejects.toThrow('terminal_handle_stale')
  })

  it('does not hold a PTY the same graph binds to another leaf', async () => {
    const { runtime } = makeHost({ livePtyIds: new Set([PTY_ID]) })
    runtime.syncWindowGraph(1, graph(PTY_ID))
    runtime.syncWindowGraph(1, graph(null, PTY_ID))

    const listing = await runtime.listTerminals()
    expect(listing.terminals.filter((terminal) => terminal.tabId === TAB_ID)).toEqual([])
  })
})
