import { terminalResumeOwnership } from '../agent-session-wire/host/structured-provider-session-ownership'
import type { LocalChatRequest } from './local-chat-operations'
import { createStructuredAgentSessionForWorktree } from '../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { getStructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-registry'
import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { acquireOrcadInstanceLock } from '../../orcad/instance-lock/orcad-instance-lock'
import { createOrcadAccountServices } from '../../orcad/account-launch/orcad-account-services'
import { loadAgentSessionClaimSigner } from '../../runtime/agent-session/ownership/agent-session-claim-identity'
import { stopStructuredAgentSessionRuntime } from '../../runtime/agent-session/installation/structured-agent-session-runtime'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-sessions/structured-agent-session'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from '../../runtime/rpc/methods/structured-sessions/attachments/structured-agent-session-attachments'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from '../../runtime/rpc/methods/structured-sessions/attachments/structured-agent-session-visual'
import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from '../../runtime/rpc/methods/structured-sessions/catalog/structured-agent-session-agents'
import type { RpcRequest } from '../../runtime/rpc/core'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatch/dispatcher-stream-options'
import { chatHostDirectory } from './local-chat-host-location'
import { openChatHostProfile } from './local-chat-host-profile'

// The chat journal owns tab visibility. Window layout is written by the attached Desktop.
class LocalChatRuntime extends OrcaRuntimeService {
  protected override changeWindowlessChatTabs(): Promise<void> {
    return Promise.resolve()
  }
}

export async function serveLocalChat(userData: string, profileId: string): Promise<void> {
  const directory = chatHostDirectory(userData)
  const lock = acquireOrcadInstanceLock(directory, { onExclusivityLost: () => process.exit(1) })
  process.once('exit', () => lock.release())
  const profile = openChatHostProfile(userData, profileId)
  const cleanup: (() => unknown)[] = []
  const accounts = createOrcadAccountServices({
    store: profile.store,
    clientCodexHomes: { selectLaunchHome: async () => null, readLaunchHome: () => null },
    registerCleanup: (dispose) => cleanup.push(() => dispose({ failed: false })),
    setClaudeStatusLineListener: () => {}
  })
  const runtime = new LocalChatRuntime(profile.store, undefined, {
    servedOrcaProfileId: profileId,
    agentSessionClaimSigner: loadAgentSessionClaimSigner(userData, userData),
    ...accounts?.runtimeDeps,
    prepareClaudeAuth: accounts?.prepareClaudeAuth,
    getDesktopWindowStatus: () => 'blocked'
  })
  accounts?.attachToRuntime(runtime)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      ...STRUCTURED_AGENT_SESSION_METHODS,
      ...STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS,
      ...STRUCTURED_AGENT_SESSION_VISUAL_METHODS,
      ...STRUCTURED_AGENT_SESSION_AGENTS_METHODS
    ]
  })
  await runtime.ensureStructuredAgentSessionHost()
  await runtime.restoreStructuredAgentSessionTabs()
  runtime.startPullRequestWatches({ admit: true })
  const token = randomUUID()
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }) =>
      !req.headers.origin && req.headers.authorization === `Bearer ${token}`
  })
  server.on('connection', (socket) => {
    const controller = new AbortController()
    socket.on('error', () => socket.terminate())
    socket.once('close', () => controller.abort())
    socket.once('message', (raw) => {
      async function dispatch(): Promise<void> {
        // Only Desktop main can authenticate. The dispatcher validates method, scope and params again.
        const {
          request,
          options,
          streaming
        }: { request: RpcRequest; options: RpcDispatchStreamingOptions; streaming: boolean } =
          JSON.parse(raw.toString())
        const reply = (frame: string): void => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(frame)
          }
        }
        const success = (result: unknown): void =>
          reply(
            JSON.stringify({
              id: request.id,
              ok: true,
              result,
              _meta: { runtimeId: runtime.getRuntimeId() }
            })
          )
        if (profile.refresh()) {
          runtime.invalidateResolvedWorktreeCache()
        }
        if (request.method.startsWith('localChat.') && request.method !== 'localChat.visibleTabs') {
          // Authenticated Desktop main writes the private envelope, outside the public method registry.
          const packet: { request: LocalChatRequest } = JSON.parse(raw.toString())
          const launch = packet.request
          switch (launch.method) {
            case 'localChat.terminalResumeOwnership':
              success(terminalResumeOwnership(await runtime.openAgentSessionRecordStore()))
              return
            case 'localChat.workspaceAttentionReads': {
              const host = getStructuredAgentSessionHost()
              if (!host) {
                throw new Error('Chat host unavailable')
              }
              success(await host.attentionReads.workspace(launch.params))
              return
            }
            case 'localChat.listWorkspaceSessions':
              success(
                (await runtime.openAgentSessionRecordStore()).listWorkspaceSessions(launch.params)
              )
              return
            case 'localChat.admitAndClaimOperation':
              success(
                await (
                  await runtime.openAgentSessionRecordStore()
                ).admitAndClaimOperation(launch.params)
              )
              return
            case 'localChat.recordOperationOutcome':
              success(
                await (
                  await runtime.openAgentSessionRecordStore()
                ).recordOperationOutcome(launch.params)
              )
              return
            case 'localChat.createLaunchSession': {
              const host = getStructuredAgentSessionHost()
              if (!host) {
                throw new Error('Local chat host unavailable')
              }
              success(
                await createStructuredAgentSessionForWorktree({
                  ...launch.params,
                  runtime,
                  ensureHost: async () => host,
                  signal: controller.signal
                })
              )
              return
            }
          }
        }
        if (request.method === 'localChat.visibleTabs') {
          const host = getStructuredAgentSessionHost()
          if (!host) {
            throw new Error('Local chat inventory unavailable')
          }
          const tabs = host
            .listSessionTabs()
            .filter((tab) => host.isSessionTabVisible(tab.sessionId))
            .map((tab) => ({ ...tab, tabId: host.getSessionTabId(tab.sessionId) }))
          success(tabs)
          return
        }
        const context = { ...options, signal: controller.signal }
        if (streaming) {
          await dispatcher.dispatchStreaming(request, reply, context)
        } else {
          reply(JSON.stringify(await dispatcher.dispatch(request, context)))
        }
      }
      void dispatch().catch((error: unknown) => {
        console.error('[local-chat-host] RPC failed', error)
        socket.close(1011, 'Chat RPC failed')
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing chat listener port')
  }
  const path = join(directory, 'endpoint.json')
  const staged = `${path}.${process.pid}`
  await writeFile(staged, JSON.stringify({ protocol: 1, profileId, port: address.port, token }), {
    mode: 0o600
  })
  await rename(staged, path)
  async function stop(): Promise<void> {
    server.close()
    for (const socket of server.clients) {
      socket.terminate()
    }
    await stopStructuredAgentSessionRuntime()
    for (const dispose of cleanup.toReversed()) {
      await dispose()
    }
    profile.close()
  }
  process.once('SIGTERM', () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}
