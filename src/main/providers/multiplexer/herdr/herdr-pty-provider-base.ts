import type { IPtyProvider } from '../../types'
import type { PtySourceRecoveryRequest, SshPtyAttachResult } from '../../ssh-pty-session-reattach'
import type { HerdrPtyBinding } from './herdr-pty-types'

export abstract class HerdrPtyProviderBase {
  protected readonly bindings = new Map<string, HerdrPtyBinding>()
  private readonly dataListeners = new Set<
    (payload: { id: string; data: string; sequenceChars?: number }) => void
  >()
  private readonly replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  private readonly exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  private fallbackUnsubscribe: (() => void)[] = []

  constructor(protected fallback: IPtyProvider) {
    this.subscribeToFallback()
  }

  replaceFallback(fallback: IPtyProvider): void {
    for (const unsubscribe of this.fallbackUnsubscribe.splice(0)) {
      unsubscribe()
    }
    this.fallback = fallback
    this.subscribeToFallback()
  }

  hasPty(id: string): boolean {
    return this.bindings.has(id) || (this.fallback.hasPty?.(id) ?? false)
  }

  write(id: string, data: string): void {
    const binding = this.bindings.get(id)
    if (binding) {
      binding.controller.write(data)
      return
    }
    this.fallback.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    const binding = this.bindings.get(id)
    if (binding) {
      binding.controller.resize(cols, rows)
      return
    }
    this.fallback.resize(id, cols, rows)
  }

  async getInitialCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    return binding ? binding.cwd : await this.fallback.getInitialCwd(id)
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    if (!this.bindings.has(id)) {
      this.fallback.acknowledgeDataEvent(id, charCount)
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const fallbackIds = ids.filter((id) => !this.bindings.has(id))
    return await this.fallback.serialize(fallbackIds)
  }

  async revive(state: string): Promise<void> {
    await this.fallback.revive(state)
  }

  async getDefaultShell(): Promise<string> {
    return await this.fallback.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return await this.fallback.getProfiles()
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    const binding = this.bindings.get(id)
    return binding
      ? { cols: binding.cols, rows: binding.rows }
      : ((await this.fallback.getAppliedSize?.(id)) ?? null)
  }

  // Why: SSH reattach runs against the routed (registered) provider so herdr-owned
  // PTYs stay on their runtime host across relay reconnect; the wrapped raw
  // SshPtyProvider owns the actual attach protocol, so forward to it.
  async attachForReconnect(
    id: string,
    expected?: { paneKey?: string; tabId?: string },
    sourceRecovery?: PtySourceRecoveryRequest
  ): Promise<SshPtyAttachResult> {
    const attachForReconnect = (
      this.fallback as unknown as {
        attachForReconnect?: (
          id: string,
          expected?: { paneKey?: string; tabId?: string },
          sourceRecovery?: PtySourceRecoveryRequest
        ) => Promise<SshPtyAttachResult>
      }
    ).attachForReconnect
    if (!attachForReconnect) {
      throw new Error('underlying provider does not support SSH reattach')
    }
    return await attachForReconnect.call(this.fallback, id, expected, sourceRecovery)
  }

  onData(
    callback: (payload: { id: string; data: string; sequenceChars?: number }) => void
  ): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  protected emitData(payload: { id: string; data: string; sequenceChars?: number }): void {
    for (const listener of this.dataListeners) {
      listener(payload)
    }
  }

  protected emitReplay(payload: { id: string; data: string }): void {
    for (const listener of this.replayListeners) {
      listener(payload)
    }
  }

  protected emitExit(payload: { id: string; code: number }): void {
    for (const listener of this.exitListeners) {
      listener(payload)
    }
  }

  protected disposeBase(): void {
    for (const unsubscribe of this.fallbackUnsubscribe) {
      unsubscribe()
    }
    this.fallbackUnsubscribe = []
  }

  private subscribeToFallback(): void {
    this.fallbackUnsubscribe = [
      this.fallback.onData((payload) => this.emitData(payload)),
      this.fallback.onReplay((payload) => this.emitReplay(payload)),
      this.fallback.onExit((payload) => this.emitExit(payload))
    ]
  }
}
