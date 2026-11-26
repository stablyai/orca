import type { LocalChatOperations } from './local-chat-operations'
import { z } from 'zod'
import { StructuredAgent } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { open, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnProcess } from '@orca/process-host'
import { WebSocket } from 'ws'
import type { RpcRequest, RpcResponse, RpcFailure, RpcSuccess } from '../../runtime/rpc/core'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatch/dispatcher-stream-options'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { chatHostDirectory, chatHostEndpoint } from './local-chat-host-location'

class ChatHostProfileMismatch extends Error {}

export class LocalChatHostClient {
  private starting?: Promise<void>
  constructor(
    private readonly userData: string,
    private readonly profileId: string
  ) {}

  private async connect(): Promise<WebSocket> {
    const path = join(chatHostDirectory(this.userData), 'endpoint.json')
    const endpoint = chatHostEndpoint.parse(JSON.parse(await readFile(path, 'utf8')))

    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      handshakeTimeout: 2000
    })
    return new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.once('open', () => {
        if (endpoint.profileId === this.profileId) {
          resolve(socket)
        } else {
          socket.close()
          reject(new ChatHostProfileMismatch('This data directory is serving another Orca profile'))
        }
      })
    })
  }

  private async launch(): Promise<void> {
    const directory = chatHostDirectory(this.userData)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const app = getAppEnvironment()
    const entry = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'local-chat-host-entry.js'
    )
    const log = await open(join(directory, 'host.log'), 'a', 0o600)
    try {
      const child = spawnProcess({
        program: process.execPath,
        args: [
          entry,
          this.userData,
          this.profileId,
          app.getAppPath(),
          app.getVersion(),
          app.getCliLauncherPath?.() ?? ''
        ],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        cwd: this.userData,
        detached: true,
        stdio: ['ignore', log.fd, log.fd]
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
    } finally {
      await log.close()
    }
    const deadline = Date.now() + 30_000
    do {
      try {
        const socket = await this.connect()
        socket.close()
        return
      } catch {
        await delay(150)
      }
    } while (Date.now() < deadline)
    throw new Error('Local chat host did not become ready. See local-chat-host/host.log.')
  }

  private async connection(): Promise<WebSocket> {
    try {
      return await this.connect()
    } catch (error) {
      if (error instanceof ChatHostProfileMismatch) {
        throw error
      }
      this.starting ??= this.launch().finally(() => {
        this.starting = undefined
      })
      await this.starting
      return this.connect()
    }
  }

  async callHost<K extends keyof LocalChatOperations>(
    method: K,
    params: Parameters<LocalChatOperations[K]>[0],
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<LocalChatOperations[K]>>> {
    const response = await this.dispatch<Awaited<ReturnType<LocalChatOperations[K]>>>(
      { id: method, method: `localChat.${method}`, params, authToken: 'local-chat' },
      { signal }
    )
    if (!response?.ok) {
      throw new Error(
        response && !response.ok ? response.error.message : 'Local chat call disconnected'
      )
    }
    return response.result
  }

  async visibleTabs() {
    const response = await this.dispatch(
      { method: 'localChat.visibleTabs', id: 'inventory', authToken: 'local-chat' },
      {}
    )
    if (!response?.ok) {
      throw new Error('Local chat inventory unavailable')
    }
    return z
      .array(
        z.object({
          sessionId: z.string(),
          workspaceId: z.string(),
          agent: StructuredAgent,
          tabId: z.string().nullable()
        })
      )
      .parse(response.result)
  }

  async dispatch<T = unknown>(
    request: RpcRequest,
    options: RpcDispatchStreamingOptions,
    receive?: (response: RpcResponse) => void
  ): Promise<RpcFailure | (RpcSuccess & { result: T }) | undefined> {
    const socket = await this.connection()
    const abort = (): void => socket.terminate()
    const {
      signal,
      connectionSignal,
      clientId,
      connectionId,
      caller,
      clientKind,
      clientCapabilities,
      callerScope,
      pairedDeviceId,
      pairedDeviceParentId,
      authenticatedCallerFingerprint
    } = options
    // A lost reply has an unknown outcome. Only reconnect before the envelope has been sent.
    return new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.once('close', () => {
        signal?.removeEventListener('abort', abort)
        connectionSignal?.removeEventListener('abort', abort)
        if (signal?.aborted || connectionSignal?.aborted) {
          resolve(undefined)
        } else {
          reject(new Error('Local chat host disconnected'))
        }
      })
      socket.on('message', (raw) => {
        try {
          const response: RpcFailure | (RpcSuccess & { result: T }) = JSON.parse(raw.toString())
          if (receive) {
            receive(response)
          }
          if (!response.ok || !response.streaming) {
            resolve(response)
            socket.close()
          }
        } catch (error) {
          reject(error)
          socket.terminate()
        }
      })
      signal?.addEventListener('abort', abort, { once: true })
      connectionSignal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || connectionSignal?.aborted) {
        abort()
        return
      }
      socket.send(
        JSON.stringify({
          request: {
            id: request.id,
            method: request.method,
            params: request.params,
            authToken: 'local-chat'
          },
          options: {
            clientId,
            connectionId,
            caller,
            clientKind,
            clientCapabilities,
            callerScope,
            pairedDeviceId,
            pairedDeviceParentId,
            authenticatedCallerFingerprint
          },
          streaming: Boolean(receive)
        })
      )
    })
  }
}
