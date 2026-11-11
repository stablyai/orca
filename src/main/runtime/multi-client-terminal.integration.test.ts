import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal/stream/terminal-stream-protocol'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './rpc/server/runtime-rpc'
import { readRuntimeMetadata } from './rpc/server/runtime-metadata'
import { sendRequest } from './rpc/server/runtime-rpc-test-harness'
import { makeStore } from './rpc/server/runtime-rpc-worktree-store-fixtures'
import { partialRuntimeStore } from './orca-runtime-tests/runtime-store-partial-fixture'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { publishHeadlessRuntimeGraph } from './session-graph/headless-runtime-graph'
import { committingSpawn } from './orca-runtime-tests/bind-first-pane.test-fixture'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: getWorktreeListingMocks().listWorktrees
}))

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: getWorktreeListingMocks().listWorktreesStrict
}))

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'a',
      isBare: false,
      isMainWorktree: false
    }
  ]
  const listings = {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
  return { getWorktreeListingMocks: () => listings }
})

const PTY_ID = 'shared-pty'
const SPAWN = { cols: 80, rows: 24 }
const WORKTREE = 'id:repo-1::/tmp/worktree-a'

type Client = Awaited<ReturnType<typeof attach>>
// Pairing handshakes can exceed waitFor's 1s default on a loaded CI worker.
const SLOW_WAIT = { timeout: 5_000 }
// Surfaced in afterEach so a protocol regression fails loudly instead of as a waitFor timeout.
const streamErrors: unknown[] = []
let attachCount = 0
const StreamResponse = z
  .object({
    type: z.string().optional(),
    streamId: z.number().optional(),
    mode: z.string().optional(),
    driver: z.object({ kind: z.string() }).optional()
  })
  .loose()
type StreamResponse = z.infer<typeof StreamResponse>

async function attach(
  pairingUrl: string,
  client: { id: string; type: 'desktop' | 'mobile' },
  terminal: string,
  viewport: { cols: number; rows: number }
) {
  const pairing = parsePairingCode(pairingUrl)!
  const responses: StreamResponse[] = []
  const frames: ReturnType<typeof decodeTerminalStreamFrame>[] = []
  const subscription: RemoteRuntimeTransportSubscription = await subscribeRemoteRuntimeTransport(
    pairedRuntimeConnectionFromOffer(pairing),
    'terminal.multiplex',
    {},
    15_000,
    {
      onResponse: (response) => {
        const parsed = response.ok ? StreamResponse.safeParse(response.result) : null
        if (parsed && !parsed.success) {
          streamErrors.push(parsed.error)
        }
        responses.push(parsed?.success ? parsed.data : {})
      },
      onBinary: (bytes) => frames.push(decodeTerminalStreamFrame(bytes)),
      onError: (error) => streamErrors.push(error)
    }
  )
  await vi.waitFor(() => expect(responses.some((r) => r.type === 'ready')).toBe(true), SLOW_WAIT)
  const streamId = 7
  let controlSeq = 0
  let inputSeq = 0
  // Each attach is a new input session, as a reconnecting app would open; a reused one dedupes seq 1.
  const inputSessionId = `${client.id}-input-session-${++attachCount}`
  const frame = (opcode: TerminalStreamOpcode, payload: Uint8Array, seq = 0) =>
    subscription.sendBinary(
      encodeTerminalStreamFrame({
        opcode,
        streamId: opcode === TerminalStreamOpcode.Subscribe ? 0 : streamId,
        seq,
        payload
      })
    )
  frame(
    TerminalStreamOpcode.Subscribe,
    encodeTerminalStreamJson({
      streamId,
      terminal,
      client,
      viewport,
      // The subset of the renderer multiplexer's capabilities that governs input and sizing.
      capabilities: {
        ackOutput: 1,
        writeUnavailable: 1,
        inputAck: 1,
        ...(client.type === 'desktop' ? { desktopViewportClaims: 1 } : {})
      },
      inputSessionId
    }),
    ++controlSeq
  )
  await vi.waitFor(
    () =>
      expect(responses.some((r) => r.type === 'subscribed' && r.streamId === streamId)).toBe(true),
    SLOW_WAIT
  )
  return {
    client,
    frames,
    responses,
    fitMode: () => responses.findLast((r) => r.type === 'fit-override-changed')?.mode,
    driver: () => responses.findLast((r) => r.type === 'driver-changed')?.driver?.kind,
    inputAcks: () => frames.filter((f) => f?.opcode === TerminalStreamOpcode.InputAck).length,
    type: (text: string) =>
      frame(TerminalStreamOpcode.Input, encodeTerminalStreamText(text), ++inputSeq),
    resize: (cols: number, rows: number) =>
      frame(TerminalStreamOpcode.Resize, encodeTerminalStreamJson({ cols, rows })),
    // Desktop/web panes claim before resizing when the user focuses/types.
    claim: (cols: number, rows: number) => {
      frame(TerminalStreamOpcode.ClaimViewport, encodeTerminalStreamJson({ cols, rows }))
      frame(TerminalStreamOpcode.Resize, encodeTerminalStreamJson({ cols, rows }))
    },
    output: () =>
      frames
        .filter((f) => f?.opcode === TerminalStreamOpcode.Output && f.streamId === streamId)
        .map((f) => decodeTerminalStreamText(f!.payload))
        .join(''),
    close: () => subscription.close()
  }
}

// Desktop app, web client and phone attach to one `orca serve`-style runtime through the shared remote-runtime client.
describe('multiple clients on one headless runtime', () => {
  const cleanups: (() => unknown)[] = []
  afterEach(async () => {
    const errors = streamErrors.splice(0)
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
    expect(errors).toEqual([])
  })

  async function start() {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-multi-client-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const writes: string[] = []
    const sizes: { cols: number; rows: number }[] = [SPAWN]
    // Headless: no notifier/window, like `orca serve`.
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
    runtime.setPtyController({
      spawn: committingSpawn(runtime, vi.fn().mockResolvedValue({ id: PTY_ID })),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      writeWithSettlement: settledWriteStub((_ptyId, data) => {
        writes.push(data)
      }),
      resize: (_ptyId, cols, rows) => {
        sizes.push({ cols, rows })
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    publishHeadlessRuntimeGraph(runtime)
    // Counts viewer departures the runtime has finished handling, so "everyone left" is observed, not slept on.
    let viewerLeaves = 0
    const unregister = runtime.unregisterRemoteDesktopViewers.bind(runtime)
    vi.spyOn(runtime, 'unregisterRemoteDesktopViewers').mockImplementation(async (...args) => {
      try {
        return await unregister(...args)
      } finally {
        viewerLeaves++
      }
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    const pair = (name: string, scope: 'runtime' | 'mobile') => {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name,
        scope
      })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      return offer.pairingUrl
    }
    const desktopUrl = pair('desktop', 'runtime')
    const metadata = readRuntimeMetadata(userDataPath)!
    const created = await sendRequest(metadata.transports[0]!.endpoint, {
      id: 'create',
      authToken: metadata.authToken,
      method: 'terminal.create',
      params: {
        worktree: WORKTREE,
        command: 'shell',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        cols: SPAWN.cols,
        rows: SPAWN.rows
      }
    })
    const handle = z.object({ terminal: z.object({ handle: z.string() }) }).parse(created.result)
      .terminal.handle
    const joinClient = async (
      url: string,
      client: { id: string; type: 'desktop' | 'mobile' },
      viewport: { cols: number; rows: number }
    ) => {
      const attached = await attach(url, client, handle, viewport)
      cleanups.push(() => attached.close())
      return attached
    }
    return {
      runtime,
      writes,
      sizes,
      size: () => sizes.at(-1)!,
      viewerLeaves: () => viewerLeaves,
      desktopUrl,
      webUrl: pair('web', 'runtime'),
      phoneUrl: pair('phone', 'mobile'),
      join: joinClient,
      handle,
      endpoint: metadata.transports[0]!.endpoint,
      authToken: metadata.authToken
    }
  }

  async function typed(client: Client, text: string) {
    const acks = client.inputAcks()
    client.type(text)
    await vi.waitFor(() => expect(client.inputAcks()).toBeGreaterThan(acks))
  }

  it('fans output out to every client and gives size to the last deliberate typist', async () => {
    const h = await start()
    const desktop = await h.join(
      h.desktopUrl,
      { id: 'desktop', type: 'desktop' },
      { cols: 200, rows: 50 }
    )
    const web = await h.join(h.webUrl, { id: 'web', type: 'desktop' }, { cols: 120, rows: 40 })
    const script = await h.join(
      h.webUrl,
      { id: 'script', type: 'desktop' },
      { cols: 100, rows: 30 }
    )
    // Attaching only observes geometry.
    expect(h.size()).toEqual(SPAWN)

    h.runtime.onPtyData(PTY_ID, 'shared-output\r\n', 1)
    await vi.waitFor(() =>
      expect([desktop, web, script].map((c) => c.output().includes('shared-output'))).toEqual([
        true,
        true,
        true
      ])
    )

    desktop.claim(200, 50)
    await typed(desktop, 'd1')
    expect(h.size()).toEqual({ cols: 200, rows: 50 })
    await vi.waitFor(() =>
      expect([desktop.fitMode(), web.fitMode()]).toEqual(['desktop-fit', 'remote-desktop-fit'])
    )

    web.claim(120, 40)
    await typed(web, 'w1')
    expect(h.size()).toEqual({ cols: 120, rows: 40 })
    await vi.waitFor(() =>
      expect([desktop.fitMode(), web.fitMode()]).toEqual(['remote-desktop-fit', 'desktop-fit'])
    )

    // Unclaimed input and passive resizes from a non-owner neither move nor block the size.
    await typed(desktop, 'd2')
    desktop.resize(210, 55)
    await typed(desktop, 'd3')
    expect(h.size()).toEqual({ cols: 120, rows: 40 })
    expect(h.writes).toEqual(['d1', 'w1', 'd2', 'd3'])

    // Two typists who both claim, taking turns: the PTY grid flips on every turn.
    for (let i = 0; i < 5; i++) {
      desktop.claim(200, 50)
      await typed(desktop, `a${i}`)
      expect(h.size()).toEqual({ cols: 200, rows: 50 })
      web.claim(120, 40)
      await typed(web, `b${i}`)
      expect(h.size()).toEqual({ cols: 120, rows: 40 })
    }
    expect(h.writes.slice(4)).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'])

    // The same race without waiting: each client's own order survives and the grid only ever
    // lands on one of the two claimed sizes. Cross-client interleaving is not guaranteed.
    const burstStart = h.sizes.length
    for (let i = 0; i < 5; i++) {
      desktop.claim(200, 50)
      desktop.type(`c${i}`)
      web.claim(120, 40)
      web.type(`e${i}`)
    }
    await vi.waitFor(() => expect(h.writes).toHaveLength(24))
    const burst = h.writes.slice(14)
    expect(burst.filter((w) => w.startsWith('c'))).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(burst.filter((w) => w.startsWith('e'))).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    for (const size of h.sizes.slice(burstStart)) {
      expect([
        { cols: 200, rows: 50 },
        { cols: 120, rows: 40 }
      ]).toContainEqual(size)
    }
  })

  it('moves size to the remaining active client when the owner drops, and a reconnect stays passive', async () => {
    const h = await start()
    const desktop = await h.join(
      h.desktopUrl,
      { id: 'desktop', type: 'desktop' },
      { cols: 200, rows: 50 }
    )
    const web = await h.join(h.webUrl, { id: 'web', type: 'desktop' }, { cols: 120, rows: 40 })
    desktop.claim(200, 50)
    await typed(desktop, 'd1')
    web.claim(120, 40)
    await typed(web, 'w1')
    expect(h.size()).toEqual({ cols: 120, rows: 40 })

    // A network blip on the owning web client resizes the PTY for everyone.
    web.close()
    await vi.waitFor(() => expect(h.size()).toEqual({ cols: 200, rows: 50 }))
    const webAgain = await h.join(h.webUrl, { id: 'web', type: 'desktop' }, { cols: 120, rows: 40 })
    await vi.waitFor(() => expect(webAgain.fitMode()).toBe('remote-desktop-fit'))
    expect(h.size()).toEqual({ cols: 200, rows: 50 })

    webAgain.claim(120, 40)
    await typed(webAgain, 'w2')
    expect(h.size()).toEqual({ cols: 120, rows: 40 })

    // Headless runtimes keep the last owner's grid once every viewer leaves.
    // Close one at a time: two sockets closing together race on which leave the server sees first.
    const leavesBefore = h.viewerLeaves()
    webAgain.close()
    await vi.waitFor(() => expect(h.viewerLeaves()).toBe(leavesBefore + 1), SLOW_WAIT)
    expect(h.size()).toEqual({ cols: 200, rows: 50 })
    const resizesBeforeLastLeave = h.sizes.length
    desktop.close()
    await vi.waitFor(() => expect(h.viewerLeaves()).toBe(leavesBefore + 2), SLOW_WAIT)
    expect(h.sizes.length).toBe(resizesBeforeLastLeave)
    expect(h.size()).toEqual({ cols: 200, rows: 50 })
  })

  it('lets a phone view at the owner size and take the size only by typing or fitting', async () => {
    const h = await start()
    const desktop = await h.join(
      h.desktopUrl,
      { id: 'desktop', type: 'desktop' },
      { cols: 200, rows: 50 }
    )
    const web = await h.join(h.webUrl, { id: 'web', type: 'desktop' }, { cols: 120, rows: 40 })
    desktop.claim(200, 50)
    await typed(desktop, 'd1')

    // Viewing only: the phone renders the owner's grid and nobody is resized or locked out.
    const resizesBeforePhone = h.sizes.length
    const phone = await h.join(h.phoneUrl, { id: 'phone', type: 'mobile' }, { cols: 50, rows: 30 })
    expect(h.runtime.getMobileDisplayMode(PTY_ID)).toBe('desktop')
    await typed(desktop, 'd2')
    await typed(web, 'w2')
    expect(h.sizes.length).toBe(resizesBeforePhone)
    expect(h.size()).toEqual({ cols: 200, rows: 50 })
    expect(h.runtime.getDriver(PTY_ID).kind).not.toBe('mobile')
    expect(h.writes).toEqual(['d1', 'd2', 'w2'])

    // Typing on the phone claims the size.
    await typed(phone, 'p1')
    await vi.waitFor(() => expect(h.size()).toEqual({ cols: 50, rows: 30 }))
    await vi.waitFor(() => expect([desktop.driver(), web.driver()]).toEqual(['mobile', 'mobile']))
    expect(h.runtime.getMobileDisplayMode(PTY_ID)).toBe('auto')

    // The desktop's take-back on the phone-driving banner reclaims its size.
    const takeBack = await sendRequest(h.endpoint, {
      id: 'take-back',
      authToken: h.authToken,
      method: 'terminal.restoreFit',
      params: { terminal: h.handle }
    })
    expect(takeBack.result).toEqual({ restored: true })
    expect(h.size()).toEqual({ cols: 200, rows: 50 })
    await vi.waitFor(() => expect(desktop.driver()).toBe('desktop'))
    await typed(desktop, 'd3')
    expect(h.writes).toEqual(['d1', 'd2', 'w2', 'p1', 'd3'])

    // The phone's explicit "fit to phone" request is a claim too.
    const fit = await sendRequest(h.endpoint, {
      id: 'fit-to-phone',
      authToken: h.authToken,
      method: 'terminal.setDisplayMode',
      params: {
        terminal: h.handle,
        mode: 'auto',
        client: { id: 'phone', type: 'mobile' },
        viewport: { cols: 50, rows: 30 }
      }
    })
    expect(fit.result).toMatchObject({ mode: 'auto' })
    expect(h.size()).toEqual({ cols: 50, rows: 30 })

    // Leaving hands the size back; reopening the terminal on the phone is a view again.
    phone.close()
    await vi.waitFor(() => expect(h.size()).toEqual({ cols: 200, rows: 50 }), SLOW_WAIT)
    const resizesBeforeReopen = h.sizes.length
    const phoneAgain = await h.join(
      h.phoneUrl,
      { id: 'phone', type: 'mobile' },
      { cols: 50, rows: 30 }
    )
    await typed(desktop, 'd4')
    expect(h.sizes.length).toBe(resizesBeforeReopen)
    expect(h.writes.at(-1)).toBe('d4')
    await typed(phoneAgain, 'p2')
    expect(h.writes.at(-1)).toBe('p2')
    await vi.waitFor(() => expect(h.size()).toEqual({ cols: 50, rows: 30 }))
  })
})
