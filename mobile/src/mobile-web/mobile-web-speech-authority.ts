import type { MobileWebSubscriptionLedgerConfig } from './mobile-web-subscription-ledger'
import type {
  MobileWebSpeechEvent,
  MobileWebSpeechStartResult,
  MobileWebSpeechStopResult
} from '../../../src/shared/mobile-web/speech-operation-contract'
import { createMobileDictationId } from '../hooks/mobile-dictation-session-state'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { MobileWebSpeechAudioForwarder } from './mobile-web-speech-audio-forwarder'
import type { MobileWebSpeechRuntime } from './mobile-web-speech-runtime'
import { acquireMobileWebSpeechStartupWake } from './mobile-web-speech-startup-wake'
import {
  cancelMobileWebRemoteSpeechSession,
  finishMobileWebRemoteSpeechSession,
  startMobileWebRemoteSpeechSession,
  type MobileWebSpeechSession
} from './mobile-web-speech-session-rpc'
import { MobileWebSpeechSubscriptions } from './mobile-web-speech-subscriptions'

export class MobileWebSpeechAuthority {
  private readonly audio = new MobileWebSpeechAudioForwarder()
  private readonly subscriptions: MobileWebSpeechSubscriptions
  private runtime: MobileWebSpeechRuntime | null = null
  private runtimePromise: Promise<MobileWebSpeechRuntime> | null = null
  private removeMicrophoneListener: (() => void) | null = null
  private removeInterruptionListener: (() => void) | null = null
  private session: MobileWebSpeechSession | null = null
  private status: MobileWebSpeechEvent['status'] = 'idle'
  private permissionGeneration: number | null = null
  private generation = 0
  private disposed = false

  constructor(
    config: MobileWebSubscriptionLedgerConfig<MobileWebSpeechEvent>,
    private readonly loadRuntime: () => Promise<MobileWebSpeechRuntime> = async () =>
      (await import('./mobile-web-speech-native-runtime')).createMobileWebSpeechNativeRuntime()
  ) {
    this.subscriptions = new MobileWebSpeechSubscriptions(config)
  }

  subscribe(args: { requestId: string; subscriptionId: string }): void {
    this.subscriptions.start(args)
  }

  async start(client: RpcClient): Promise<MobileWebSpeechStartResult> {
    if (this.disposed) {
      throw new MobileWebBrokerError('cancelled')
    }
    if (this.session) {
      return this.session.acceptingChunks ? { status: 'recording' } : { status: 'unavailable' }
    }
    const generation = ++this.generation
    const runtime = await this.ensureRuntime()
    this.permissionGeneration = generation
    const permission = await runtime.requestMicrophonePermission().finally(() => {
      if (this.permissionGeneration === generation) {
        this.permissionGeneration = null
      }
    })
    if (!this.isCurrentGeneration(generation)) {
      return { status: 'unavailable' }
    }
    if (!permission.granted) {
      return { status: 'permission-denied' }
    }
    if (!(await runtime.waitForForeground()) || !this.isCurrentGeneration(generation)) {
      return { status: 'unavailable' }
    }
    if (!(await runtime.initialize()) || !this.isCurrentGeneration(generation)) {
      return { status: 'unavailable' }
    }

    const session: MobileWebSpeechSession = {
      id: createMobileDictationId(),
      client,
      generation,
      acceptingChunks: false,
      remoteCancelSent: false
    }
    this.session = session
    let startResult: MobileWebSpeechStartResult | null
    try {
      startResult = await startMobileWebRemoteSpeechSession(client, session.id)
    } catch (error) {
      if (this.isCurrentSession(session)) {
        await this.releaseSession(session, { reason: 'host-error' })
      }
      throw error
    }
    if (!this.isCurrentSession(session)) {
      await this.cancelRemoteSession(session)
      return { status: 'unavailable' }
    }
    if (startResult) {
      await this.releaseSession(session, { reason: 'cancelled' })
      return startResult
    }

    await acquireMobileWebSpeechStartupWake(runtime, session.id)
    if (!this.isCurrentSession(session)) {
      await this.cancelRemoteSession(session)
      await runtime.releaseKeepAwake(session.id).catch(() => undefined)
      return { status: 'unavailable' }
    }
    if (!runtime.toggleRecording(true)) {
      await this.releaseSession(session, { reason: 'host-error' })
      return { status: 'unavailable' }
    }
    session.acceptingChunks = true
    this.status = 'recording'
    this.postState({ status: 'recording' })
    return { status: 'recording' }
  }

  async stop(): Promise<MobileWebSpeechStopResult> {
    const session = this.session
    if (!session) {
      return { status: 'cancelled' }
    }
    session.acceptingChunks = false
    this.status = 'processing'
    this.postState({ status: 'processing' })
    this.stopRuntimeRecording()
    await this.audio.drain()
    if (!this.isCurrentSession(session)) {
      return { status: 'cancelled' }
    }

    let result: MobileWebSpeechStopResult
    try {
      result = await finishMobileWebRemoteSpeechSession(session.client, session.id)
    } catch (error) {
      if (!this.isCurrentSession(session)) {
        return { status: 'cancelled' }
      }
      await this.releaseSession(session, { reason: 'host-error' })
      throw error
    }
    if (!this.isCurrentSession(session)) {
      return { status: 'cancelled' }
    }
    await this.releaseSession(session, { cancelRemote: false })
    return result
  }

  async cancel(reason: MobileWebSpeechEvent['reason'] = 'cancelled'): Promise<void> {
    const session = this.session
    const wasActive = session !== null || this.status !== 'idle'
    this.generation += 1
    if (!session) {
      if (wasActive) {
        this.setIdle(reason)
      }
      return
    }
    await this.releaseSession(session, { reason })
  }

  cancelForAppBackground(): void {
    if (this.permissionGeneration === null) {
      void this.cancel('interrupted')
    }
  }

  cancelSubscription(subscriptionId: string): string | null {
    return this.subscriptions.cancel(subscriptionId)
  }

  cancelByRequest(requestId: string): void {
    this.subscriptions.cancelByRequest(requestId)
  }

  countForOperation(operationKey: string): number {
    return this.subscriptions.countForOperation(operationKey)
  }

  replaceClient(): void {
    void this.cancel('session-replaced')
  }

  dispose(): void {
    this.disposed = true
    void this.cancel('session-replaced')
    this.subscriptions.dispose()
    this.removeMicrophoneListener?.()
    this.removeInterruptionListener?.()
    this.removeMicrophoneListener = null
    this.removeInterruptionListener = null
    void this.runtime?.tearDown()
  }

  private async ensureRuntime(): Promise<MobileWebSpeechRuntime> {
    if (this.runtime) {
      return this.runtime
    }
    this.runtimePromise ??= this.loadRuntime()
    const runtime = await this.runtimePromise
    if (this.disposed) {
      void runtime.tearDown()
      throw new MobileWebBrokerError('cancelled')
    }
    if (!this.runtime) {
      this.runtime = runtime
      this.removeMicrophoneListener = runtime.addMicrophoneListener((event) =>
        this.handleMicrophoneData(event)
      )
      this.removeInterruptionListener = runtime.addInterruptionListener((kind) => {
        if (kind === 'began' || kind === 'blocked') {
          void this.cancel('interrupted')
        }
      })
    }
    return this.runtime
  }

  private handleMicrophoneData(event: { data: Uint8Array }): void {
    const session = this.session
    if (!session?.acceptingChunks || this.status !== 'recording') {
      return
    }
    this.audio.forward({
      client: session.client,
      dictationId: session.id,
      event,
      isCurrent: () => this.session === session && session.acceptingChunks,
      fail: (error) => {
        const reason =
          error instanceof Error && error.message.includes('too slow')
            ? 'connection-slow'
            : 'host-error'
        void this.cancel(reason)
      }
    })
  }

  private async releaseSession(
    session: MobileWebSpeechSession,
    options: {
      reason?: MobileWebSpeechEvent['reason']
      cancelRemote?: boolean
    } = {}
  ): Promise<void> {
    if (this.session === session) {
      this.session = null
    }
    session.acceptingChunks = false
    this.audio.reset()
    this.stopRuntimeRecording()
    const cleanups = [this.runtime?.releaseKeepAwake(session.id) ?? Promise.resolve()]
    if (options.cancelRemote !== false) {
      cleanups.push(this.cancelRemoteSession(session))
    }
    await Promise.allSettled(cleanups)
    this.setIdle(options.reason)
  }

  private async cancelRemoteSession(session: MobileWebSpeechSession): Promise<void> {
    if (session.remoteCancelSent) {
      return
    }
    session.remoteCancelSent = true
    await cancelMobileWebRemoteSpeechSession(session.client, session.id)
  }

  private stopRuntimeRecording(): void {
    try {
      this.runtime?.toggleRecording(false)
    } catch {
      // Continue releasing independently owned host and wake-lock state.
    }
  }

  private setIdle(reason?: MobileWebSpeechEvent['reason']): void {
    const changed = this.status !== 'idle'
    this.status = 'idle'
    if (changed || reason) {
      this.postState({ status: 'idle', ...(reason ? { reason } : {}) })
    }
  }

  private postState(event: MobileWebSpeechEvent): void {
    this.subscriptions.post(event)
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.generation === generation
  }

  private isCurrentSession(session: MobileWebSpeechSession): boolean {
    return this.isCurrentGeneration(session.generation) && this.session === session
  }
}
