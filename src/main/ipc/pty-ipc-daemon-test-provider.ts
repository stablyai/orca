import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { TerminalHost } from '../daemon/terminal-host'
import { prepareMacosTccLoginShell } from '../providers/macos-tcc-login-shell'
import { createPtySubprocess } from '../daemon/pty-subprocess'
import type { DaemonEvent, DaemonRequest } from '../daemon/types'
import { WRITE_ACCEPTED } from '../../shared/pty-write-settlement'

/** Replaces transport only; IPC tests exercise real daemon launch, session and exit behavior. */
export class PtyIpcDaemonTestProvider extends DaemonPtyAdapter {
  private readonly host = new TerminalHost({
    spawnSubprocess: async (options) => {
      await prepareMacosTccLoginShell()
      return createPtySubprocess(options)
    }
  })
  private readonly eventHandlers = new Set<(event: unknown) => void>()
  private readonly attachments = new Map<string, symbol>()

  constructor() {
    super({ socketPath: '/test/pty-ipc.sock', tokenPath: '/test/pty-ipc.token' })
    this.client.ensureConnected = async () => {}
    this.client.ensureConnectedWithin = async () => {}
    this.client.isConnected = () => true
    this.client.onEvent = (handler) => {
      this.eventHandlers.add(handler)
      return () => this.eventHandlers.delete(handler)
    }
    this.client.request = async <T>(type: string, payload: unknown): Promise<T> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the real adapter's typed requests enter this test transport.
      const request = { id: 'ipc-test', type, payload } as DaemonRequest
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each route returns the host result expected by the real adapter's RPC call.
      return (await this.route(request)) as T
    }
    this.client.notify = (type, payload) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Notifications originate from the real adapter, with its protocol payloads.
      this.route({ id: 'ipc-test-notify', type, payload } as DaemonRequest)
      return true
    }
    this.client.notifyWithSettlement = async (type, payload) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Notifications originate from the real adapter, with its protocol payloads.
      await this.route({ id: 'ipc-test-notify', type, payload } as DaemonRequest)
      return WRITE_ACCEPTED
    }
  }

  private emit(event: DaemonEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }

  private route(request: DaemonRequest): unknown {
    switch (request.type) {
      case 'createOrAttach': {
        const { historySeed, ...payload } = request.payload
        return this.host
          .createOrAttach({
            ...payload,
            ...(historySeed ? { historySeedChunks: [historySeed] } : {}),
            streamClient: {
              onData: (data, rawLength, transformed, seq) =>
                this.emit({
                  type: 'event',
                  event: 'data',
                  sessionId: payload.sessionId,
                  payload: { data, rawLength, transformed, seq }
                }),
              onExit: (code, incarnationId, cause) =>
                this.emit({
                  type: 'event',
                  event: 'exit',
                  sessionId: payload.sessionId,
                  payload: { code, incarnationId, ...(cause ? { cause } : {}) }
                })
            }
          })
          .then((result) => {
            this.attachments.set(payload.sessionId, result.attachToken)
            return result
          })
      }
      case 'listSessions':
        return { sessions: this.host.listSessions() }
      case 'getSize':
        return { size: this.host.getAppliedSize(request.payload.sessionId) }
      case 'write':
        return this.host.write(request.payload.sessionId, request.payload.data)
      case 'resize':
        return this.host.resize(
          request.payload.sessionId,
          request.payload.cols,
          request.payload.rows
        )
      case 'pausePty':
        return this.host.pauseProducer(request.payload.sessionId)
      case 'resumePty':
        return this.host.resumeProducer(request.payload.sessionId)
      case 'kill':
        return this.host.kill(request.payload.sessionId, { immediate: request.payload.immediate })
      case 'signal':
        return this.host.signal(request.payload.sessionId, request.payload.signal)
      case 'getCwd':
        return this.host.getCwd(request.payload.sessionId).then((cwd) => ({ cwd }))
      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }
      case 'getSnapshot':
        return { snapshot: this.host.getSnapshot(request.payload.sessionId) }
      case 'takePendingOutput':
        return this.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot ?? false
        )
      case 'clearScrollback':
        return this.host.clearScrollback(request.payload.sessionId)
      case 'closeStartupQueryAuthority':
        return { appliedSeq: this.host.closeStartupQueryAuthority(request.payload.sessionId) }
      case 'detach': {
        const token = this.attachments.get(request.payload.sessionId)
        if (token) {
          this.host.detach(request.payload.sessionId, token)
        }
        this.attachments.delete(request.payload.sessionId)
        return {}
      }
      case 'setSessionBackground':
        return {}
      case 'abortHistorySeedTransfer':
      case 'appendHistorySeedTransfer':
      case 'cancelCreateOrAttach':
      case 'closeTransientPty':
      case 'confirmForegroundProcess':
      case 'confirmShellForeground':
      case 'createTransientPty':
      case 'finishHistorySeedTransfer':
      case 'inspectProcess':
      case 'ping':
      case 'ptySpawnHealth':
      case 'shutdown':
      case 'shutdownIfIdle':
      case 'startHistorySeedTransfer':
      case 'systemResolverHealth':
      case 'writeTransientPty':
        throw new Error(`IPC daemon test transport does not implement ${request.type}`)
    }
  }

  async disposeHost(): Promise<void> {
    this.dispose()
    await this.host.dispose()
  }
}
