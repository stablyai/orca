import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '../../shared/child-process/process-tree-termination'
import type { LanguageServerId } from '../../shared/language-server-types'
import {
  LSP_SEMANTIC_TOKEN_MODIFIERS,
  LSP_SEMANTIC_TOKEN_TYPES
} from '../../shared/lsp-semantic-token-legend'
import { LspMessageRouter, isJsonRpcMessage, type JsonRpcMessage } from './lsp-message-router'
import type { ResolvedLspCommand } from './lsp-server-command'
import { LspStderrTail } from './lsp-stderr-tail'

type LspChildProcess = ReturnType<typeof spawnProcess>

export type LspPort = {
  post(message: unknown): void
  onMessage(listener: (data: unknown) => void): void
  onClose(listener: () => void): void
  close(): void
}

export type LspSessionConfig = {
  serverId: LanguageServerId
  rootPath: string
  command: ResolvedLspCommand
  initializationOptions: unknown
  idleShutdownMs: number
  onExit: (unexpected: boolean) => void
  spawn?: (spec: ProcessSpec) => LspChildProcess
}

const INITIALIZE_TIMEOUT_MS = 120_000 // Why: ruby-lsp installs its composed bundle on first start.
const SHUTDOWN_GRACE_MS = 2_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export class LspSession {
  readonly ready: Promise<void>
  private readonly child: LspChildProcess
  private readonly router: LspMessageRouter
  private readonly ports = new Map<number, LspPort>()
  private readonly queued: { portId: number; message: JsonRpcMessage }[] = []
  private readonly exitedPromise: Promise<void>
  private readonly stderr: LspStderrTail
  private nextPortId = 1
  private isReady = false
  private exited = false
  private disposing = false
  private failed = false
  private loggedFailure = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly config: LspSessionConfig) {
    const rootUri = pathToFileURL(config.rootPath).toString()
    this.child = (config.spawn ?? spawnProcess)({
      program: config.command.program,
      args: config.command.args,
      cwd: config.rootPath,
      env: config.command.env,
      // Why: own process group for tree kill; piped stdin still makes the server exit on EOF if Orca dies.
      detached: process.platform !== 'win32',
      timeoutMs: null
    })
    const writer = new StreamMessageWriter(this.child.stdin)
    this.router = new LspMessageRouter(
      (message) => void writer.write(message).catch(() => undefined),
      [{ uri: rootUri, name: basename(config.rootPath) }]
    )
    new StreamMessageReader(this.child.stdout).listen((message) => this.onServerMessage(message))
    this.stderr = new LspStderrTail(this.child.stderr)
    this.exitedPromise = new Promise((resolve) => {
      const onGone = (detail: string): void => {
        this.onChildExit(detail)
        resolve()
      }
      this.child.once('exit', (code, signal) =>
        onGone(signal ? `exited with signal ${signal}` : `exited with code ${code}`)
      )
      // Why: kill() failures can emit 'error' repeatedly on a live process; only a failed spawn means it never ran.
      this.child.on('error', (error) => {
        if (this.child.pid === undefined) {
          onGone(`failed to spawn: ${error.message}`)
        }
      })
    })
    this.ready = this.initialize(rootUri)
    this.ready.catch((error: unknown) => {
      if (!this.disposing) {
        this.failed = true
        this.logFailure(
          `failed to start: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      void this.dispose({ force: true })
    })
    // Why: if the port never arrives (sender gone, post failed), the session must still idle out.
    this.armIdleTimer()
  }

  attachPort(port: LspPort): void {
    if (this.disposing || this.exited) {
      port.close()
      return
    }
    const portId = this.nextPortId++
    this.ports.set(portId, port)
    this.clearIdleTimer()
    port.onMessage((data) => {
      if (isJsonRpcMessage(data)) {
        this.fromPort(portId, data)
      }
    })
    port.onClose(() => this.detachPort(portId))
  }

  async dispose(options: { force?: boolean } = {}): Promise<void> {
    if (this.disposing) {
      return
    }
    this.disposing = true
    this.clearIdleTimer()
    this.closePorts()
    if (!this.exited) {
      if (!options.force) {
        await withTimeout(this.router.request('shutdown', null), SHUTDOWN_GRACE_MS).catch(
          () => undefined
        )
        this.router.notify('exit', null)
      }
      const exitedInTime = await withTimeout(
        this.exitedPromise,
        options.force ? 0 : SHUTDOWN_GRACE_MS
      ).then(
        () => true,
        () => false
      )
      if (!exitedInTime) {
        await forceTerminateProcessTree(this.child)
      } else {
        this.killLeftoverGroup()
      }
    }
    this.config.onExit(this.failed)
  }

  private async initialize(rootUri: string): Promise<void> {
    const result = await withTimeout(
      this.router.request('initialize', {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(this.config.rootPath) }],
        initializationOptions: this.config.initializationOptions,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            semanticTokens: {
              requests: { full: true },
              tokenTypes: LSP_SEMANTIC_TOKEN_TYPES,
              tokenModifiers: LSP_SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false
            }
          },
          workspace: { workspaceFolders: true, configuration: true, symbol: {} }
        }
      }),
      INITIALIZE_TIMEOUT_MS
    )
    this.router.setServerCapabilities(result)
    this.router.notify('initialized', {})
    this.isReady = true
    for (const { portId, message } of this.queued.splice(0)) {
      this.fromPort(portId, message)
    }
  }

  private fromPort(portId: number, message: JsonRpcMessage): void {
    if (!this.ports.has(portId)) {
      return
    }
    if (!this.isReady) {
      this.queued.push({ portId, message })
      return
    }
    const reply = this.router.fromClient(portId, message)
    if (reply) {
      this.ports.get(portId)?.post(reply)
    }
  }

  private onServerMessage(message: unknown): void {
    if (!isJsonRpcMessage(message)) {
      return
    }
    const routed = this.router.fromServer(message)
    if (routed) {
      this.ports.get(routed.portId)?.post(routed.message)
    }
  }

  private detachPort(portId: number): void {
    if (!this.ports.delete(portId)) {
      return
    }
    this.router.detachPort(portId)
    const kept = this.queued.filter((entry) => entry.portId !== portId)
    this.queued.splice(0, this.queued.length, ...kept)
    if (this.ports.size === 0) {
      this.armIdleTimer()
    }
  }

  private armIdleTimer(): void {
    if (!this.disposing) {
      this.clearIdleTimer()
      this.idleTimer = setTimeout(() => void this.dispose(), this.config.idleShutdownMs)
    }
  }

  private onChildExit(detail: string): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.router.rejectInternal(new Error('language server exited'))
    this.killLeftoverGroup()
    if (!this.disposing) {
      this.logFailure(detail)
      this.disposing = true
      this.clearIdleTimer()
      this.closePorts()
      this.config.onExit(true)
    }
  }

  private logFailure(detail: string): void {
    if (this.loggedFailure) {
      return
    }
    this.loggedFailure = true
    const { serverId, rootPath } = this.config
    this.stderr.whenFlushed((tail) => {
      console.warn(
        `[lsp] ${serverId} language server for ${rootPath} ${detail}${tail ? `; stderr:\n${tail}` : ''}`
      )
    })
  }

  // Why: grandchildren in the detached group can outlive the root and ignore EOF.
  private killLeftoverGroup(): void {
    if (process.platform !== 'win32') {
      void signalProcessTree(this.child, 'SIGKILL').catch(() => undefined)
    }
  }

  private closePorts(): void {
    for (const port of this.ports.values()) {
      port.close()
    }
    this.ports.clear()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
