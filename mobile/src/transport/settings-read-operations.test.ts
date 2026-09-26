import { describe, expect, it, vi } from 'vitest'
import { loadMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-loader'
import { FLOATING_WORKSPACE_WORKTREE_ID } from '../session/floating-workspace'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { markRpcDeliveryUnknown, isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { LogicalClientCutoverError, isLogicalClientCutoverError } from './stable-logical-rpc-client'
import {
  settingsRead,
  optionalSettingsRead,
  botOverridesRead,
  newTabSettingsRead,
  terminalCopyTrimsGutterRead
} from './settings-read-operations'
import type { RpcResponse } from './types'

function success(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function refusal(message = 'settings refused'): RpcResponse {
  return {
    id: 'reply',
    ok: false,
    error: { code: 'runtime_error', message },
    _meta: { runtimeId: 'runtime' }
  }
}

function deferred() {
  let resolve!: (response: RpcResponse) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<RpcResponse>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function replyWith(response: RpcResponse) {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(response)
  return client
}

async function drain() {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
}

describe('settings historical acceptance', () => {
  it('distinguishes a skipped refusal from an accepted absent settings member', async () => {
    const skipped = await settingsRead.request(replyWith(refusal()))
    const missing = await settingsRead.request(replyWith(success({})))
    expect(settingsRead.interpret(skipped)).toEqual({ accepted: false })
    expect(settingsRead.interpret(missing)).toEqual({ accepted: true, value: undefined })
  })

  it('retains opaque settings fields and reference identity without tightening acceptance', async () => {
    const value = { futureField: { nested: ['kept'] }, disabledTuiAgents: 'legacy-value' }
    const reply = await settingsRead.request(replyWith(success({ settings: value })))
    const result = settingsRead.interpret(reply)
    expect(result.accepted && result.value).toBe(value)
  })

  it.each([null, undefined])(
    'preserves the unguarded settings read for %s only when interpreted',
    async (value) => {
      const reply = await settingsRead.request(replyWith(success(value)))
      expect(() => settingsRead.interpret(reply)).toThrow(TypeError)
      expect(() => settingsRead.interpret(reply)).toThrow(
        `Cannot read properties of ${String(value)} (reading 'settings')`
      )
      const optional = await optionalSettingsRead.request(replyWith(success(value)))
      expect(optionalSettingsRead.interpret(optional)).toEqual({ accepted: true, value: undefined })
    }
  )

  it.each([true, false, 0, 'text', []])('preserves property boxing for %j', async (value) => {
    const reply = await settingsRead.request(replyWith(success(value)))
    expect(settingsRead.interpret(reply)).toEqual({ accepted: true, value: undefined })
  })

  it('filters bot logins while distinguishing a refused refresh', async () => {
    const reply = await botOverridesRead.request(
      replyWith(success({ settings: { prBotAuthorOverrides: ['bot', 3, null, ''] } }))
    )
    expect(botOverridesRead.interpret(reply)).toEqual({ accepted: true, value: ['bot', ''] })
    const refused = await botOverridesRead.request(replyWith(refusal()))
    expect(botOverridesRead.interpret(refused)).toEqual({ accepted: false })
    const empty = await botOverridesRead.request(replyWith(success(null)))
    expect(botOverridesRead.interpret(empty)).toEqual({ accepted: true, value: [] })
  })

  it('reads the gutter-trim preference, treating an older host as opted in', async () => {
    const off = await terminalCopyTrimsGutterRead.request(
      replyWith(success({ settings: { terminalCopyTrimsGutter: false } }))
    )
    expect(terminalCopyTrimsGutterRead.interpret(off)).toEqual({ accepted: true, value: false })
    const on = await terminalCopyTrimsGutterRead.request(
      replyWith(success({ settings: { terminalCopyTrimsGutter: true } }))
    )
    expect(terminalCopyTrimsGutterRead.interpret(on)).toEqual({ accepted: true, value: true })
    // A host predating the setting sends no key; the desktop default is on.
    const absent = await terminalCopyTrimsGutterRead.request(replyWith(success({ settings: {} })))
    expect(terminalCopyTrimsGutterRead.interpret(absent)).toEqual({ accepted: true, value: true })
    const empty = await terminalCopyTrimsGutterRead.request(replyWith(success(null)))
    expect(terminalCopyTrimsGutterRead.interpret(empty)).toEqual({ accepted: true, value: true })
    const refused = await terminalCopyTrimsGutterRead.request(replyWith(refusal()))
    expect(terminalCopyTrimsGutterRead.interpret(refused)).toEqual({ accepted: false })
  })

  it('does not read a stale payload until its caller permits interpretation', async () => {
    const read = vi.fn(() => ({}))
    const reply = await settingsRead.request(
      replyWith(
        success({
          get settings() {
            return read()
          }
        })
      )
    )
    expect(read).not.toHaveBeenCalled()
    settingsRead.interpret(reply)
    expect(read).toHaveBeenCalledOnce()
  })

  it('keeps sender argument presence and options intact', async () => {
    const client = replyWith(success({ settings: {} }))
    await settingsRead.request(client)
    await settingsRead.request(client, undefined)
    const options = { timeoutMs: 1234, failWhenDisconnected: true }
    await settingsRead.request(client, undefined, options)
    expect(client.sendRequest.mock.calls).toEqual([
      ['settings.get'],
      ['settings.get', undefined],
      ['settings.get', undefined, options]
    ])
  })

  it('keeps original delivery-unknown and cutover errors on the rejection channel', async () => {
    for (const error of [
      markRpcDeliveryUnknown(new Error('ambiguous')),
      new LogicalClientCutoverError()
    ]) {
      const client = new FakeSession('connected')
      client.sendRequest.mockRejectedValue(error)
      const caught = await settingsRead.request(client).catch((value: unknown) => value)
      expect(caught).toBe(error)
      expect(isRpcDeliveryUnknown(caught)).toBe(isRpcDeliveryUnknown(error))
      expect(isLogicalClientCutoverError(caught)).toBe(isLogicalClientCutoverError(error))
    }
  })
})

describe('new-tab settlement barriers', () => {
  function load(client: FakeSession) {
    return loadMobileNewTabAgentOptions({ client, worktreeId: FLOATING_WORKSPACE_WORKTREE_ID })
  }

  it('waits for the peer after a settings refusal and reports only the host message', async () => {
    const peer = deferred()
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation((method) =>
      method === 'settings.get' ? Promise.resolve(refusal()) : peer.promise
    )
    let settled = false
    const outcome = load(client).catch((error: unknown) => {
      settled = true
      return error
    })
    await drain()
    expect(settled).toBe(false)
    peer.resolve(success([]))
    expect(await outcome).toEqual(new Error('settings refused'))
  })

  it('lets a peer transport failure win over a fulfilled settings refusal', async () => {
    const peer = deferred()
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation((method) =>
      method === 'settings.get' ? Promise.resolve(refusal()) : peer.promise
    )
    const outcome = load(client).catch((error: unknown) => error)
    await drain()
    const error = markRpcDeliveryUnknown(new Error('agents disconnected'))
    peer.reject(error)
    expect(await outcome).toBe(error)
  })

  it('rejects immediately on settings transport failure while its peer stays pending', async () => {
    const peer = deferred()
    const client = new FakeSession('connected')
    const error = new Error('settings disconnected')
    client.sendRequest.mockImplementation((method) =>
      method === 'settings.get' ? Promise.reject(error) : peer.promise
    )
    let caught: unknown
    const outcome = load(client).catch((value: unknown) => {
      caught = value
    })
    await drain()
    expect(caught).toBe(error)
    peer.resolve(success([]))
    await outcome
  })

  it('checks the peer refusal before accessing a null settings payload', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'settings.get' ? success(null) : refusal('agents refused')
    )
    await expect(load(client)).rejects.toThrow('agents refused')
    const reply = await newTabSettingsRead.request(replyWith(success(null)))
    const readSettings = newTabSettingsRead.interpret(reply)
    expect(() => readSettings()).toThrow(TypeError)
  })
})

describe('the bound descriptor', () => {
  // Eleven call sites pass `interpret` detached from its descriptor, five of them
  // settlePreviewSend's second argument in files/mobile-file-preview-request.ts:
  // filePreviewTextRead, filePreviewImageRead, terminalArtifactTextRead,
  // terminalArtifactImageRead and terminalArtifactWrite.
  it('interprets the same reply when taken as an unbound reference', async () => {
    const settings = { futureField: 'kept' }
    const accepted = await settingsRead.request(replyWith(success({ settings })))
    const readSettings = settingsRead.interpret
    expect(readSettings(accepted)).toEqual(settingsRead.interpret(accepted))
    expect(readSettings(accepted)).toEqual({ accepted: true, value: settings })

    const refused = await botOverridesRead.request(replyWith(refusal()))
    const readOverrides = botOverridesRead.interpret
    expect(readOverrides(refused)).toEqual(botOverridesRead.interpret(refused))
    expect(readOverrides(refused)).toEqual({ accepted: false })

    // The throwing acceptance family keeps its throw unbound rather than losing it.
    const missing = await newTabSettingsRead.request(replyWith(success(null)))
    const readNewTab = newTabSettingsRead.interpret
    expect(() => readNewTab(missing)()).toThrow(TypeError)
  })
})
