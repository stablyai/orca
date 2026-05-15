/* eslint-disable max-lines -- Why: this suite covers runtime environment
   management, secret redaction, one-shot RPC, and streaming cleanup contracts. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import * as environmentStore from '../../shared/runtime-environment-store'

const {
  handleMock,
  onMock,
  getPathMock,
  sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequestMock,
  sendRemoteRuntimeConnectionRequestMock,
  closeRemoteRuntimeRequestConnectionMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn(),
  subscribeRemoteRuntimeRequestMock: vi.fn(),
  sendRemoteRuntimeConnectionRequestMock: vi.fn(),
  closeRemoteRuntimeRequestConnectionMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, on: onMock }
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
}))

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function handler<TArgs, TResult>(
  channel: string
): (_event: unknown, args: TArgs) => TResult | Promise<TResult> {
  const match = handleMock.mock.calls.find((call) => call[0] === channel)
  expect(match).toBeTruthy()
  return match![1] as (_event: unknown, args: TArgs) => TResult | Promise<TResult>
}

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    getPathMock.mockReset()
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    onMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    subscribeRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeConnectionRequestMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers desktop runtime environment management handlers', () => {
    registerRuntimeEnvironmentHandlers()

    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:list',
      'runtimeEnvironments:addFromPairingCode',
      'runtimeEnvironments:resolve',
      'runtimeEnvironments:remove',
      'runtimeEnvironments:getStatus',
      'runtimeEnvironments:call',
      'runtimeEnvironments:subscribe',
      'runtimeEnvironments:unsubscribe'
    ])
    expect(onMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:subscriptionBinary'
    ])
  })

  it('stores, resolves, lists, and removes environments under Electron userData', async () => {
    registerRuntimeEnvironmentHandlers()

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    expect(JSON.stringify(added)).not.toContain('device-token')
    expect(JSON.stringify(added)).not.toContain('publicKeyB64')

    const list = handler<undefined, { id: string; name: string }[]>('runtimeEnvironments:list')
    expect(await list(null, undefined)).toMatchObject([{ id: added.environment.id, name: 'desk' }])
    expect(JSON.stringify(await list(null, undefined))).not.toContain('device-token')

    const resolve = handler<{ selector: string }, { id: string; name: string }>(
      'runtimeEnvironments:resolve'
    )
    expect(await resolve(null, { selector: 'desk' })).toMatchObject({
      id: added.environment.id,
      name: 'desk'
    })
    expect(JSON.stringify(await resolve(null, { selector: 'desk' }))).not.toContain('device-token')

    const remove = handler<{ selector: string }, { removed: { id: string; name: string } }>(
      'runtimeEnvironments:remove'
    )
    const removed = await remove(null, { selector: added.environment.id })
    expect(removed).toMatchObject({
      removed: { id: added.environment.id, name: 'desk' }
    })
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(added.environment.id)
    expect(JSON.stringify(removed)).not.toContain('device-token')
    expect(await list(null, undefined)).toEqual([])
  })

  it('checks a saved remote runtime and records the runtime id on success', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { runtimeId: 'runtime-remote', graphStatus: 'ready' },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const getStatus = handler<
      { selector: string; timeoutMs?: number },
      { ok: true; result: { runtimeId: string } }
    >('runtimeEnvironments:getStatus')
    expect(await getStatus(null, { selector: 'desk', timeoutMs: 50 })).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-remote' }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768', deviceToken: 'device-token' }),
      'status.get',
      undefined,
      50
    )

    const resolve = handler<{ selector: string }, { id: string; runtimeId: string | null }>(
      'runtimeEnvironments:resolve'
    )
    expect(await resolve(null, { selector: added.environment.id })).toMatchObject({
      id: added.environment.id,
      runtimeId: 'runtime-remote'
    })
  })

  it('proxies generic one-shot RPC calls to the saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-2',
      ok: true,
      result: { repos: [{ id: 'repo-1' }] },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    expect(
      await call(null, { selector: 'desk', method: 'repo.list', timeoutMs: 75 })
    ).toMatchObject({
      ok: true,
      result: { repos: [{ id: 'repo-1' }] }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'repo.list',
      undefined,
      75
    )
    expect(sendRemoteRuntimeConnectionRequestMock).not.toHaveBeenCalled()
  })

  it('uses the cached request connection for terminal hot path RPCs', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeConnectionRequestMock.mockResolvedValue({
      id: 'rpc-terminal',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    expect(
      await call(null, {
        selector: 'desk',
        method: 'terminal.send',
        params: { terminal: 't1', text: 'a' },
        timeoutMs: 75
      })
    ).toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.send',
      { terminal: 't1', text: 'a' },
      75
    )
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('limits background one-shot RPCs without blocking foreground runtime calls', async () => {
    registerRuntimeEnvironmentHandlers()
    const pendingBackground: ((value: unknown) => void)[] = []
    sendRemoteRuntimeRequestMock.mockImplementation(async () => {
      return await new Promise((resolve) => pendingBackground.push(resolve))
    })
    sendRemoteRuntimeConnectionRequestMock.mockResolvedValue({
      id: 'terminal-send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    const bg1 = call(null, { selector: 'desk', method: 'hostedReview.forBranch' })
    const bg2 = call(null, { selector: 'desk', method: 'github.listWorkItems' })
    await vi.waitFor(() => expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(2))

    const bg3 = call(null, { selector: 'desk', method: 'git.status' })
    const foreground = call(null, {
      selector: 'desk',
      method: 'terminal.send',
      params: { terminal: 'term-1', text: 'a' }
    })
    await vi.waitFor(() =>
      expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
        'hostedReview.forBranch',
        'github.listWorkItems'
      ])
    )
    expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'terminal.send',
      { terminal: 'term-1', text: 'a' },
      15_000
    )

    await expect(foreground).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(pendingBackground).toHaveLength(2)

    pendingBackground.shift()?.({
      id: 'background-1',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-remote' }
    })
    await vi.waitFor(() => expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(3))
    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'hostedReview.forBranch',
      'github.listWorkItems',
      'git.status'
    ])

    pendingBackground.splice(0).forEach((resolve) =>
      resolve({
        id: 'background',
        ok: true,
        result: null,
        _meta: { runtimeId: 'runtime-remote' }
      })
    )
    await expect(bg1).resolves.toMatchObject({ ok: true })
    await expect(bg2).resolves.toMatchObject({ ok: true })
    await expect(bg3).resolves.toMatchObject({ ok: true })
  })

  it('starts and stops streaming subscriptions for a saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const sendBinary = vi.fn()
    const markUsedSpy = vi.spyOn(environmentStore, 'markEnvironmentUsed')
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _timeoutMs, callbacks) => {
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'subscribed' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'data', chunk: 'hello' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onBinary(new Uint8Array([1, 2, 3]))
        return { requestId: 'stream-1', close, sendBinary }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const sent: unknown[] = []
    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: (_channel: string, payload: unknown) => sent.push(payload),
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        timeoutMs: 25,
        subscriptionId: 'preload-sub-1'
      }
    )

    expect(result.requestId).toBe('stream-1')
    expect(result.subscriptionId).toBe('preload-sub-1')
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.subscribe',
      { terminal: 't1' },
      25,
      expect.any(Object)
    )
    expect(sent).toEqual([
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'binary' })
    ])
    expect(markUsedSpy).toHaveBeenCalledTimes(1)

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    const bytes = new Uint8Array([9, 8, 7])
    binaryListener({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId, bytes })
    expect(sendBinary).toHaveBeenCalledWith(bytes)

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
    markUsedSpy.mockRestore()
  })

  it('rejects cross-window streaming subscription control', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-1',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'owned-sub'
      }
    )

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    binaryListener(
      { sender: { id: 2 } },
      { subscriptionId: result.subscriptionId, bytes: new Uint8Array([1]) }
    )
    expect(sendBinary).not.toHaveBeenCalled()

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 2 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()

    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
  })

  it('closes a streaming subscription that resolves after the sender is destroyed', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    let resolveSubscribe: (value: {
      requestId: string
      close: () => void
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
    }) => void = () => {}
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    let destroyed = false
    let destroyedHandler: unknown = null
    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const resultPromise = subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => destroyed,
          send: vi.fn(),
          once: vi.fn((_event: string, handler: () => void) => {
            destroyedHandler = () => {
              destroyed = true
              handler()
            }
          }),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'late-sub'
      }
    )

    await vi.waitFor(() => {
      expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalled()
    })
    expect(destroyedHandler).toBeTypeOf('function')
    ;(destroyedHandler as () => void)()
    resolveSubscribe({ requestId: 'stream-late', close, sendBinary: vi.fn() })

    await expect(resultPromise).resolves.toEqual({
      subscriptionId: 'late-sub',
      requestId: 'stream-late'
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'late-sub' })).toEqual({
      unsubscribed: false
    })
  })

  it('removes the destroyed listener when streaming subscription setup rejects', async () => {
    registerRuntimeEnvironmentHandlers()
    subscribeRemoteRuntimeRequestMock.mockRejectedValue(new Error('connect failed'))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')

    await expect(
      subscribe(
        {
          sender: {
            id: 1,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
            removeListener: destroyedListenerRemoved
          }
        },
        {
          selector: 'desk',
          method: 'terminal.subscribe',
          params: { terminal: 't1' },
          subscriptionId: 'failed-sub'
        }
      )
    ).rejects.toThrow('connect failed')

    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })
})
