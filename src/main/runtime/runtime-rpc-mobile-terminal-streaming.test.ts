import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  sendEncryptedWsRequest,
  createEncryptedWsResponseReader
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
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

describe('OrcaRuntimeRpcServer', () => {
  it('mirrors laptop-created remote runtime terminals into phone session tabs over RPC', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const endpoint = metadata!.transports[0]!.endpoint
    const authToken = metadata!.authToken
    const leafId = '11111111-1111-4111-8111-111111111111'
    const createResponse = await sendRequest(endpoint, {
      id: 'laptop_create',
      authToken,
      method: 'terminal.create',
      params: {
        worktree: 'id:repo-1::/tmp/worktree-a',
        command: "claude 'work on the issue'",
        terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' },
        tabId: 'laptop-tab',
        leafId,
        presentation: 'background'
      }
    })

    expect(createResponse).toMatchObject({
      id: 'laptop_create',
      ok: true,
      result: {
        terminal: {
          worktreeId: 'repo-1::/tmp/worktree-a',
          surface: 'background'
        }
      }
    })
    expect(
      (createResponse.result as { terminal?: { warning?: string } } | undefined)?.terminal?.warning
    ).toBeUndefined()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' }
      })
    )
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 456)
    runtime.onPtyData('laptop-created-pty', 'Claude is working...\r\n', 456)

    const listResponse = await sendRequest(endpoint, {
      id: 'phone_list',
      authToken,
      method: 'session.tabs.list',
      params: {
        worktree: 'id:repo-1::/tmp/worktree-a'
      }
    })

    const terminal = (
      createResponse.result as {
        terminal: { handle: string }
      }
    ).terminal
    expect(listResponse).toMatchObject({
      id: 'phone_list',
      ok: true,
      result: {
        tabs: [
          {
            type: 'terminal',
            id: `laptop-tab::${leafId}`,
            parentTabId: 'laptop-tab',
            leafId,
            status: 'ready',
            terminal: terminal.handle,
            agentStatus: {
              state: 'working',
              paneKey: `laptop-tab:${leafId}`,
              terminalHandle: terminal.handle
            }
          }
        ]
      }
    })

    const readResponse = await sendRequest(endpoint, {
      id: 'phone_read',
      authToken,
      method: 'terminal.read',
      params: {
        terminal: terminal.handle
      }
    })
    expect(readResponse).toMatchObject({
      id: 'phone_read',
      ok: true,
      result: {
        terminal: {
          tail: ['Claude is working...']
        }
      }
    })

    await server.stop()
  })

  it('streams laptop-created runtime terminals to a paired phone WebSocket client', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'paired-laptop-pty' })
    runtime.setPtyController({
      spawn,
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    const phoneOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'phone',
      scope: 'mobile'
    })
    expect(phoneOffer.available).toBe(true)
    if (!phoneOffer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    expect(parsePairingCode(phoneOffer.pairingUrl)?.scope).toBe('mobile')
    const phone = await authenticateMobileWsSession(phoneOffer.pairingUrl)
    const phoneResponses = createEncryptedWsResponseReader(phone)
    const metadata = readRuntimeMetadata(userDataPath)
    const laptopEndpoint = metadata!.transports[0]!.endpoint
    const laptopAuthToken = metadata!.authToken
    const worktree = 'id:repo-1::/tmp/worktree-a'
    const leafId = '11111111-1111-4111-8111-111111111111'

    try {
      sendEncryptedWsRequest(phone, {
        id: 'phone_subscribe_tabs',
        method: 'session.tabs.subscribe',
        params: { worktree }
      })
      await expect(
        phoneResponses.next('phone_subscribe_tabs', (response) => {
          const result = response.result as { type?: string; tabs?: unknown[] } | undefined
          return result?.type === 'snapshot' && result.tabs?.length === 0
        })
      ).resolves.toMatchObject({
        ok: true,
        streaming: true
      })

      const blockedUpdate = phoneResponses.next('phone_subscribe_tabs', (response) => {
        const result = response.result as { type?: string; tabs?: unknown[] } | undefined
        const tab = result?.tabs?.[0] as { agentStatus?: { state?: string } } | undefined
        return result?.type === 'updated' && tab?.agentStatus?.state === 'blocked'
      })
      const createResponse = await sendRequest(laptopEndpoint, {
        id: 'laptop_create',
        authToken: laptopAuthToken,
        method: 'terminal.create',
        params: {
          worktree,
          command: "claude 'work on the issue'",
          tabId: 'laptop-tab',
          leafId,
          activate: true
        }
      })
      const terminal = (
        createResponse.result as {
          terminal: { handle: string }
        }
      ).terminal
      runtime.onPtyData('paired-laptop-pty', '\x1b]0;Claude waiting for permission\x07', 456)
      runtime.onPtyData('paired-laptop-pty', 'Need approval\r\n', 457)

      await expect(blockedUpdate).resolves.toMatchObject({
        ok: true,
        streaming: true,
        result: {
          type: 'updated',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              status: 'ready',
              terminal: terminal.handle,
              agentStatus: {
                state: 'blocked',
                paneKey: `laptop-tab:${leafId}`,
                terminalHandle: terminal.handle
              }
            }
          ]
        }
      })

      sendEncryptedWsRequest(phone, {
        id: 'phone_read',
        method: 'terminal.read',
        params: { terminal: terminal.handle }
      })
      await expect(phoneResponses.next('phone_read')).resolves.toMatchObject({
        ok: true,
        result: {
          terminal: {
            tail: ['Need approval']
          }
        }
      })

      sendEncryptedWsRequest(phone, {
        id: 'phone_send',
        method: 'terminal.send',
        params: {
          terminal: terminal.handle,
          text: 'approved'
        }
      })
      await expect(phoneResponses.next('phone_send')).resolves.toMatchObject({
        ok: true,
        result: {
          send: {
            accepted: true
          }
        }
      })
      expect(writes).toEqual(['approved'])
    } finally {
      phoneResponses.dispose()
      phone.ws.close()
      await server.stop()
    }
  })

  it('authorizes a mobile artifact tap after first-connect backfill even once the raw window scrolls', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getCwd: async () => '/tmp/worktree-a',
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    // Real artifact under the temp root so the grant path stats it.
    const artifactPath = join(tmpdir(), `orca-artifact-${process.pid}-${Date.now()}.json`)
    await writeFile(artifactPath, '{"ok":true}')

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Agent',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    // Path printed before any mobile client exists: tracking is inactive, so
    // only the retained raw window knows it at connect time.
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)

    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'phone',
      scope: 'mobile'
    })
    expect(offer.available).toBe(true)
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    // Full direct E2EE authentication drives MobileSocketWiring.onReady (the
    // relay transport attaches through the same wiring), which must backfill
    // candidates from the raw window without any direct activation call.
    const phone = await authenticateMobileWsSession(offer.pairingUrl)
    const phoneResponses = createEncryptedWsResponseReader(phone)
    try {
      // Post-connect pathless output scrolls the artifact out of the raw
      // 64KiB window; only the connect-time backfilled candidate can answer.
      runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

      sendEncryptedWsRequest(phone, {
        id: 'phone_terminals',
        method: 'terminal.list',
        params: { worktree: 'id:repo-1::/tmp/worktree-a' }
      })
      const listResponse = await phoneResponses.next('phone_terminals')
      const handle = (listResponse.result as { terminals: { handle: string }[] }).terminals[0]!
        .handle
      expect(handle).toBeTruthy()

      sendEncryptedWsRequest(phone, {
        id: 'phone_tap',
        method: 'files.resolveTerminalPath',
        params: {
          worktree: 'id:repo-1::/tmp/worktree-a',
          pathText: artifactPath,
          terminal: handle
        }
      })
      await expect(phoneResponses.next('phone_tap')).resolves.toMatchObject({
        ok: true,
        result: {
          exists: true,
          isDirectory: false,
          openTarget: {
            kind: 'absolute-file',
            provider: 'local',
            grantId: expect.any(String)
          }
        }
      })
    } finally {
      phoneResponses.dispose()
      phone.ws.close()
      await server.stop()
      await rm(artifactPath, { force: true })
    }
  })

  it('completes remote E2EE authentication against a runtime proxy without activateRecentPtyPathCandidateTracking', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Why: a remote-host runtime proxy only implements RPC-forwarded methods;
    // activation is a local-host concern, so the proxy legitimately lacks
    // activateRecentPtyPathCandidateTracking and onReady must not throw.
    const runtimeProxy = {
      getRuntimeId: () => 'proxy-runtime-test',
      getStartedAt: () => 1,
      getStatus: () => ({ graphStatus: 'unavailable' }),
      cleanupSubscriptionsForConnection: () => {},
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {}
    } as unknown as OrcaRuntimeService
    expect(
      (runtimeProxy as { activateRecentPtyPathCandidateTracking?: unknown })
        .activateRecentPtyPathCandidateTracking
    ).toBeUndefined()
    const server = new OrcaRuntimeRpcServer({
      runtime: runtimeProxy,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'remote',
      scope: 'runtime'
    })
    expect(offer.available).toBe(true)
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    // Real E2EE pairing + authentication drives MobileSocketWiring.onReady
    // before e2ee_authenticated is sent; a throwing onReady never authenticates.
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const responses = createEncryptedWsResponseReader(session)
    try {
      sendEncryptedWsRequest(session, { id: 'proxy_status', method: 'status.get' })
      await expect(responses.next('proxy_status')).resolves.toMatchObject({
        id: 'proxy_status',
        ok: true,
        result: { graphStatus: 'unavailable' }
      })
    } finally {
      responses.dispose()
      session.ws.close()
      await server.stop()
    }
  })

  it('keeps active runtime multiplex streams responsive while a background stream is ACK-limited over WebSocket', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const writes: { terminal: string; text: string }[] = []
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'multiplex-background-pty' })
      .mockResolvedValueOnce({ id: 'multiplex-active-pty' })
    runtime.setPtyController({
      spawn,
      write: (ptyId, data) => {
        writes.push({ terminal: ptyId, text: data })
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    const phoneOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'phone',
      scope: 'mobile'
    })
    expect(phoneOffer.available).toBe(true)
    if (!phoneOffer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const pairing = parsePairingCode(phoneOffer.pairingUrl)
    expect(pairing).toBeTruthy()
    if (!pairing) {
      throw new Error('Pairing URL did not parse')
    }

    const metadata = readRuntimeMetadata(userDataPath)
    const laptopEndpoint = metadata!.transports[0]!.endpoint
    const laptopAuthToken = metadata!.authToken
    const worktree = 'id:repo-1::/tmp/worktree-a'
    const backgroundLeafId = '11111111-1111-4111-8111-111111111111'
    const activeLeafId = '22222222-2222-4222-8222-222222222222'
    const backgroundCreateResponse = await sendRequest(laptopEndpoint, {
      id: 'laptop_create_background',
      authToken: laptopAuthToken,
      method: 'terminal.create',
      params: {
        worktree,
        command: 'background',
        tabId: 'multiplex-background-tab',
        leafId: backgroundLeafId
      }
    })
    const activeCreateResponse = await sendRequest(laptopEndpoint, {
      id: 'laptop_create_active',
      authToken: laptopAuthToken,
      method: 'terminal.create',
      params: {
        worktree,
        command: 'active',
        tabId: 'multiplex-active-tab',
        leafId: activeLeafId,
        activate: true
      }
    })
    const backgroundTerminal = (backgroundCreateResponse.result as { terminal: { handle: string } })
      .terminal
    const activeTerminal = (activeCreateResponse.result as { terminal: { handle: string } })
      .terminal

    const responses: Record<string, unknown>[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const onError = vi.fn()
    const subscription = await subscribeRemoteRuntimeRequest(
      pairing,
      'terminal.multiplex',
      {},
      15_000,
      {
        onResponse: (response) => responses.push(response as Record<string, unknown>),
        onBinary: (bytes) => binaryFrames.push(bytes),
        onError
      }
    )

    try {
      await vi.waitFor(() =>
        expect(
          responses.some(
            (response) => (response.result as { type?: string } | undefined)?.type === 'ready'
          )
        ).toBe(true)
      )
      subscription.sendBinary(
        encodeTerminalStreamFrame({
          seq: 1,
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          payload: encodeTerminalStreamJson({
            streamId: 21,
            terminal: backgroundTerminal.handle,
            client: { id: 'desktop-background', type: 'desktop' },
            capabilities: { ackOutput: 1 }
          })
        })
      )
      subscription.sendBinary(
        encodeTerminalStreamFrame({
          seq: 2,
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          payload: encodeTerminalStreamJson({
            streamId: 22,
            terminal: activeTerminal.handle,
            client: { id: 'desktop-active', type: 'desktop' },
            capabilities: { ackOutput: 1 }
          })
        })
      )
      await vi.waitFor(() => {
        const subscribedStreamIds = responses
          .map((response) => response.result as { type?: string; streamId?: number } | undefined)
          .filter((result) => result?.type === 'subscribed')
          .map((result) => result?.streamId)
        expect(subscribedStreamIds).toEqual(expect.arrayContaining([21, 22]))
      })
      binaryFrames.splice(0)

      const backgroundOutput = 'B'.repeat(700 * 1024)
      runtime.onPtyData('multiplex-background-pty', backgroundOutput, 1)
      await vi.waitFor(() => {
        const backgroundFrames = binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output && frame.streamId === 21)
        const backgroundBytes = backgroundFrames.reduce(
          (total, frame) => total + (frame?.payload.byteLength ?? 0),
          0
        )
        expect(backgroundBytes).toBeGreaterThan(0)
        expect(backgroundBytes).toBeLessThan(backgroundOutput.length)
      })

      const frameCountBeforeActive = binaryFrames.length
      runtime.onPtyData('multiplex-active-pty', 'ACTIVE_MULTIPLEX_READY\r\n', 2)
      await vi.waitFor(() => {
        const activeOutput = binaryFrames
          .slice(frameCountBeforeActive)
          .map((frame) => decodeTerminalStreamFrame(frame))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output && frame.streamId === 22)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
        expect(activeOutput).toContain('ACTIVE_MULTIPLEX_READY')
      })

      subscription.sendBinary(
        encodeTerminalStreamFrame({
          seq: 3,
          opcode: TerminalStreamOpcode.Input,
          streamId: 22,
          payload: encodeTerminalStreamText('still interactive\r')
        })
      )
      await vi.waitFor(() =>
        expect(writes).toContainEqual({
          terminal: 'multiplex-active-pty',
          text: 'still interactive\r'
        })
      )

      const backgroundBytesBeforeAck = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output && frame.streamId === 21)
        .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
      subscription.sendBinary(
        encodeTerminalStreamFrame({
          seq: 4,
          opcode: TerminalStreamOpcode.Ack,
          streamId: 21,
          payload: encodeTerminalStreamJson({ bytes: backgroundBytesBeforeAck })
        })
      )
      await vi.waitFor(() => {
        const backgroundBytesAfterAck = binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output && frame.streamId === 21)
          .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
        expect(backgroundBytesAfterAck).toBeGreaterThan(backgroundBytesBeforeAck)
      })
      expect(onError).not.toHaveBeenCalled()
    } finally {
      subscription.close()
      await server.stop()
    }
  })
})
