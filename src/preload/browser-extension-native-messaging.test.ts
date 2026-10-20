import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionInvokeReply } from './browser-extension-main-world'
import {
  installBrowserExtensionNativeMessaging,
  PRELOAD_NATIVE_MESSAGING_NAMESPACE,
  type BrowserExtensionNativeMessagingContext
} from './browser-extension-native-messaging'

type Reply = BrowserExtensionInvokeReply
type Call = { method: string; args: unknown[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Calls `path` (e.g. 'onMessage.addListener') on `owner` with its parent as `this`. */
function call(owner: unknown, path: string, ...args: unknown[]): unknown {
  const keys = path.split('.')
  const leaf = keys.pop() ?? ''
  const parent = keys.reduce<unknown>(
    (value, key) => (isRecord(value) ? value[key] : undefined),
    owner
  )
  const fn = isRecord(parent) ? parent[leaf] : undefined
  if (typeof fn !== 'function') {
    throw new Error(`${path} is not a function`)
  }
  return fn.apply(parent, args)
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(
  permissions: Record<string, string[]>,
  context: BrowserExtensionNativeMessagingContext = 'page'
) {
  const runtime: Record<string, unknown> = { getManifest: () => permissions }
  const browserRuntime: Record<string, unknown> = {}
  const calls: Call[] = []
  const listens: unknown[][] = []
  const pending = new Map<string, (reply: Reply) => void>()
  let dispatch: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const bridge = {
    call: (namespace: string, method: string, args: unknown[]) => {
      expect(namespace).toBe(PRELOAD_NATIVE_MESSAGING_NAMESPACE)
      calls.push({ method, args })
      return new Promise<Reply>((resolve) => pending.set(`${method}:${String(args[0])}`, resolve))
    },
    listen: (namespace: string, event: string, active: boolean) =>
      listens.push([namespace, event, active]),
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    },
    passesFilter: () => true
  }
  const error = vi.fn()
  const realm = {
    chrome: { runtime },
    browser: { runtime: browserRuntime },
    console: { error },
    JSON,
    Math,
    Date,
    Promise
  }
  runInNewContext(`(${installBrowserExtensionNativeMessaging.toString()})(bridge, context)`, {
    ...realm,
    globalThis: realm,
    bridge,
    context
  })
  return {
    runtime,
    browserRuntime,
    calls,
    listens,
    error,
    /** The id the installer chose for the n-th call's port. */
    portId: (index = 0) => String(calls[index]?.args[0]),
    lastError: () => (isRecord(runtime.lastError) ? runtime.lastError.message : undefined),
    reply: (key: string, value: Reply) => pending.get(key)?.(value),
    emit: (args: unknown[]) => dispatch?.(PRELOAD_NATIVE_MESSAGING_NAMESPACE, 'onPortEvent', args)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('chrome.runtime native messaging in extension contexts', () => {
  it('exists only for extensions that ask for nativeMessaging, on chrome and browser', () => {
    expect(install({ permissions: ['storage'] }).runtime.connectNative).toBeUndefined()
    const optional = install({ optional_permissions: ['nativeMessaging'] })
    expect(typeof optional.runtime.connectNative).toBe('function')
    expect(optional.browserRuntime.sendNativeMessage).toBe(optional.runtime.sendNativeMessage)
  })

  it('queues posts until the host runs and routes replies by port', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const port = call(page.runtime, 'connectNative', 'com.example.vault')
    const received: unknown[][] = []
    call(port, 'onMessage.addListener', (message: unknown, from: unknown) =>
      received.push([message, from === port])
    )
    call(port, 'postMessage', { hello: 'é' })
    expect(isRecord(port) && port.name).toBe('')
    const id = page.portId()
    expect(page.calls).toEqual([{ method: 'connect', args: [id, 'com.example.vault'] }])
    // A reply can beat the connect answer; it still reaches the port.
    page.emit([id, 'message', '{"early":true}'])
    page.reply(`connect:${id}`, { ok: true, value: undefined })
    await tick()
    expect(page.calls[1]).toEqual({ method: 'postMessage', args: [id, '{"hello":"é"}'] })
    page.emit(['another-port', 'message', '{"stray":1}'])
    expect(received).toEqual([[{ early: true }, true]])
    expect(page.listens).toEqual([])
  })

  it('fires onDisconnect with runtime.lastError set only during the call', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const port = call(page.runtime, 'connectNative', 'com.example.missing')
    const seen: unknown[] = []
    call(port, 'onDisconnect.addListener', () => seen.push(page.lastError()))
    page.reply(`connect:${page.portId()}`, {
      ok: false,
      error: 'Specified native messaging host not found.'
    })
    await tick()
    expect(seen).toEqual(['Specified native messaging host not found.'])
    expect(page.runtime.lastError).toBeUndefined()
    expect(() => call(port, 'postMessage', 1)).toThrow(
      'Attempting to use a disconnected port object'
    )
  })

  it('logs an unchecked lastError when nobody listens for the disconnect', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    call(page.runtime, 'connectNative', 'com.example.vault')
    page.reply(`connect:${page.portId()}`, { ok: true, value: undefined })
    await tick()
    page.emit([page.portId(), 'disconnect', 'Native host has exited.'])
    expect(page.error).toHaveBeenCalledWith('Unchecked runtime.lastError: Native host has exited.')
  })

  it('lets main release a port the extension dropped while it was starting', async () => {
    const worker = install({ permissions: ['nativeMessaging'] }, 'worker')
    const port = call(worker.runtime, 'connectNative', 'com.example.vault')
    expect(worker.listens).toEqual([[PRELOAD_NATIVE_MESSAGING_NAMESPACE, 'onPortEvent', true]])
    call(port, 'disconnect')
    worker.reply(`connect:${worker.portId()}`, { ok: true, value: undefined })
    await tick()
    expect(worker.calls.at(-1)).toEqual({ method: 'disconnect', args: [worker.portId()] })
  })

  it('answers sendNativeMessage with a promise, or a callback that sees lastError', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const promised = call(page.runtime, 'sendNativeMessage', 'com.example.vault', { q: 1 })
    expect(page.calls[0]).toEqual({
      method: 'sendNativeMessage',
      args: ['com.example.vault', '{"q":1}']
    })
    page.reply('sendNativeMessage:com.example.vault', { ok: true, value: '{"a":2}' })
    await expect(promised).resolves.toEqual({ a: 2 })

    const results: unknown[] = []
    call(page.runtime, 'sendNativeMessage', 'com.example.gone', 1, (response: unknown) =>
      results.push([response, page.lastError()])
    )
    await tick()
    page.reply('sendNativeMessage:com.example.gone', {
      ok: false,
      error: 'Native host has exited.'
    })
    await tick()
    expect(results).toEqual([[undefined, 'Native host has exited.']])
  })
})
