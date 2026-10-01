import { app, webContents } from 'electron'
import { dirname } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '../../../shared/child-process/run-process'
import {
  emitToExtensionCaller,
  handleExtensionApi,
  type ExtensionCaller
} from './extension-api-host'
import { numberArg, stringArg } from './extension-api-args'
import { findNativeMessagingHost } from './native-messaging-host-manifest'
import { createNativeMessageReader, encodeNativeMessage } from './native-message-codec'

type Port = { host: ChildProcessWithoutNullStreams; caller: ExtensionCaller; cleanup: () => void }

const ports = new Map<number, Port>()
let nextPortId = 1

/** Starts host `name` for the caller's extension, if the host lets that extension in. */
async function startHost(
  caller: ExtensionCaller,
  name: string
): Promise<ChildProcessWithoutNullStreams> {
  const host = await findNativeMessagingHost(name, app.getPath('userData'))
  const origin = `chrome-extension://${caller.extension.id}/`
  if (!host || !host.allowedOrigins.includes(origin)) {
    throw new Error('Specified native messaging host not found.')
  }
  // Chrome passes the caller's origin, and on Windows the parent window handle, as arguments.
  const args = process.platform === 'win32' ? [origin, '--parent-window=0'] : [origin]
  const child = spawnProcess({ program: host.path, args, cwd: dirname(host.path) })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.stdin.on('error', () => {
    // The host exited; its 'exit' reports the disconnect.
  })
  child.stderr.on('data', (chunk: Buffer) =>
    console.warn(`[browser-extensions] ${name}:`, chunk.toString().trimEnd())
  )
  return child
}

function closePort(id: number, error?: string): void {
  const port = ports.get(id)
  if (!port) {
    return
  }
  ports.delete(id)
  port.cleanup()
  port.host.kill()
  emitToExtensionCaller(port.caller, 'runtime.nativePort', [id, 'disconnect', error ?? null])
}

handleExtensionApi('nativePort', {
  open: async (caller: ExtensionCaller, application: unknown) => {
    const host = await startHost(caller, stringArg(application, 'application'))
    const id = nextPortId++
    // Why: a page's port dies with the page, and every port with its extension, as in Chrome.
    const page = caller.frame && webContents.fromFrame(caller.frame)
    const onPageGone = (): void => closePort(id)
    const onUnloaded = (_event: Electron.Event, extension: Electron.Extension): void => {
      if (extension.id === caller.extension.id) {
        closePort(id)
      }
    }
    page?.once('destroyed', onPageGone)
    caller.session.extensions.on('extension-unloaded', onUnloaded)
    const cleanup = (): void => {
      page?.off('destroyed', onPageGone)
      caller.session.extensions.off('extension-unloaded', onUnloaded)
    }
    ports.set(id, { host, caller, cleanup })
    const read = createNativeMessageReader((message) =>
      emitToExtensionCaller(caller, 'runtime.nativePort', [id, 'message', message])
    )
    host.stdout.on('data', (chunk: Buffer) => {
      try {
        read(chunk)
      } catch (error) {
        closePort(id, error instanceof Error ? error.message : String(error))
      }
    })
    host.once('exit', () => closePort(id, 'Native host has exited.'))
    return id
  },
  post: (_caller: ExtensionCaller, id: unknown, message: unknown) => {
    ports.get(numberArg(id, 'port'))?.host.stdin.write(encodeNativeMessage(message))
  },
  disconnect: (_caller: ExtensionCaller, id: unknown) => closePort(numberArg(id, 'port'))
})

handleExtensionApi('runtime', {
  sendNativeMessage: async (caller: ExtensionCaller, application: unknown, message: unknown) => {
    const host = await startHost(caller, stringArg(application, 'application'))
    try {
      return await new Promise((resolve, reject) => {
        const read = createNativeMessageReader(resolve)
        host.stdout.on('data', (chunk: Buffer) => {
          try {
            read(chunk)
          } catch (error) {
            reject(error)
          }
        })
        host.once('exit', () => reject(new Error('Native host has exited.')))
        host.stdin.write(encodeNativeMessage(message))
      })
    } finally {
      host.kill()
    }
  }
})
