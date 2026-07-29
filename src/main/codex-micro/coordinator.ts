import type { EventEmitter } from 'node:events'
import type { CodexMicroSettings } from '../../shared/codex-micro-settings'
import {
  parseCodexMicroConnectionState,
  parseCodexMicroInputEvent,
  type CodexMicroConnectionState,
  type CodexMicroInputEvent
} from '../../shared/codex-micro-types'
import { CodexMicroSidecarProcess } from './sidecar-process'
import { resolveCodexMicroSidecarPath } from './sidecar-path'
import { buildCodexMicroLightingSnapshot } from './lighting-snapshot'

type StoreLike = {
  getSettings(): { codexMicro?: CodexMicroSettings }
  onSettingsChanged(listener: (updates: { codexMicro?: CodexMicroSettings }) => void): () => void
}

type SidecarProcessLike = EventEmitter & {
  start(): void
  stop(): void
  write(message: Record<string, unknown>): void
}

type CoordinatorOptions = {
  store: StoreLike
  resolveBinaryPath?: () => string | null
  createProcess?: (binaryPath: string) => SidecarProcessLike
}

const CRASH_LIMIT = 3
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export class CodexMicroCoordinator {
  private state: CodexMicroConnectionState = { kind: 'disabled' }
  private process: SidecarProcessLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private crashCount = 0
  private released = false
  private lastLightingSnapshot: string | null = null
  private unsubscribeSettings: (() => void) | null = null
  private readonly stateListeners = new Set<(state: CodexMicroConnectionState) => void>()
  private readonly inputListeners = new Set<(event: CodexMicroInputEvent) => void>()
  private readonly resolveBinaryPath: () => string | null
  private readonly createProcess: (binaryPath: string) => SidecarProcessLike

  constructor(private readonly options: CoordinatorOptions) {
    this.resolveBinaryPath = options.resolveBinaryPath ?? resolveCodexMicroSidecarPath
    this.createProcess =
      options.createProcess ?? ((binaryPath) => new CodexMicroSidecarProcess(binaryPath))
  }

  start(): void {
    if (!this.unsubscribeSettings) {
      this.unsubscribeSettings = this.options.store.onSettingsChanged((updates) => {
        if (!updates.codexMicro) {
          return
        }
        if (updates.codexMicro.enabled) {
          if (this.state.kind === 'disabled') {
            this.retry()
          } else {
            this.sendLightingSnapshot(updates.codexMicro)
          }
        } else {
          this.disable()
        }
      })
    }
    if (!this.options.store.getSettings().codexMicro?.enabled) {
      this.setState({ kind: 'disabled' })
      return
    }
    this.startProcess()
  }

  getState(): CodexMicroConnectionState {
    return this.state
  }

  subscribeState(listener: (state: CodexMicroConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  subscribeInput(listener: (event: CodexMicroInputEvent) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  setOutputSnapshot(rgbcfg: unknown, thstatus: unknown): void {
    this.process?.write({ type: 'output_snapshot', rgbcfg, thstatus })
  }

  retry(): void {
    if (!this.options.store.getSettings().codexMicro?.enabled) {
      return
    }
    this.released = false
    this.crashCount = 0
    this.clearReconnectTimer()
    this.startProcess()
  }

  release(): void {
    this.released = true
    this.clearReconnectTimer()
    const process = this.process
    this.process = null
    this.lastLightingSnapshot = null
    if (process) {
      process.write({ type: 'release' })
      process.stop()
    }
    this.setState({ kind: 'disconnected' })
  }

  dispose(): void {
    this.release()
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = null
    this.stateListeners.clear()
    this.inputListeners.clear()
  }

  private disable(): void {
    this.released = true
    this.clearReconnectTimer()
    const process = this.process
    this.process = null
    this.lastLightingSnapshot = null
    if (process) {
      process.write({ type: 'release' })
      process.stop()
    }
    this.setState({ kind: 'disabled' })
  }

  private startProcess(): void {
    if (this.process || this.reconnectTimer || this.released) {
      return
    }
    const binaryPath = this.resolveBinaryPath()
    if (!binaryPath) {
      this.setState({
        kind: 'error',
        code: 'binary-missing',
        message: 'codex-micro sidecar is unavailable'
      })
      return
    }

    const process = this.createProcess(binaryPath)
    this.lastLightingSnapshot = null
    this.process = process
    process.on('frame', (frame) => this.handleFrame(process, frame))
    process.on('decode-error', () => this.handleProtocolError(process))
    process.on('exit', (code) => this.handleExit(process, code))
    process.on('error', () => this.handleExit(process, 1))
    this.setState({ kind: 'connecting' })
    process.start()
  }

  private handleFrame(process: SidecarProcessLike, frame: unknown): void {
    if (this.process !== process || !isRecord(frame)) {
      return
    }
    if (frame.type === 'connection_state') {
      const state = parseCodexMicroConnectionState(frame.state)
      if (!state) {
        return
      }
      if (state.kind === 'connected' || state.kind === 'read-only') {
        this.crashCount = 0
      }
      this.setState(state)
      if (state.kind === 'connected') {
        const settings = this.options.store.getSettings().codexMicro
        if (settings) {
          this.sendLightingSnapshot(settings)
        }
      }
      return
    }
    if (frame.type === 'input_event') {
      const event = parseCodexMicroInputEvent(frame.event)
      if (!event) {
        return
      }
      for (const listener of this.inputListeners) {
        listener(event)
      }
      return
    }
    if (frame.type === 'error') {
      this.setState({
        kind: 'error',
        code: 'sidecar-error',
        message: 'codex-micro sidecar reported an error'
      })
    }
  }

  private handleProtocolError(process: SidecarProcessLike): void {
    if (this.process !== process) {
      return
    }
    this.setState({
      kind: 'error',
      code: 'protocol-error',
      message: 'codex-micro sidecar protocol error'
    })
  }

  private handleExit(process: SidecarProcessLike, code: number | null): void {
    if (this.process !== process) {
      return
    }
    this.process = null
    this.lastLightingSnapshot = null
    if (this.released || !this.options.store.getSettings().codexMicro?.enabled || code === 0) {
      this.setState({ kind: 'disconnected' })
      return
    }

    this.crashCount += 1
    if (this.crashCount >= CRASH_LIMIT) {
      this.setState({
        kind: 'error',
        code: 'crash-loop',
        message: 'codex-micro sidecar crashed repeatedly'
      })
      return
    }

    this.setState({ kind: 'disconnected' })
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.crashCount - 1), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.startProcess()
    }, delay)
  }

  private setState(state: CodexMicroConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  private sendLightingSnapshot(settings: CodexMicroSettings): void {
    if (this.state.kind !== 'connected' || !this.process) {
      return
    }
    const snapshot = buildCodexMicroLightingSnapshot({
      enabled: settings.lightingEnabled,
      brightness: settings.brightness
    })
    const serialized = JSON.stringify(snapshot)
    if (serialized === this.lastLightingSnapshot) {
      return
    }
    this.lastLightingSnapshot = serialized
    this.process.write({ type: 'output_snapshot', ...snapshot })
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
