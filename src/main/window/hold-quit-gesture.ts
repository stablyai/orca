import {
  isHoldQuitChord,
  type HoldQuitInput,
  type HoldQuitNotice
} from '../../shared/mac-hold-quit'

export type HoldQuitWatchEvent = 'watching' | 'held' | 'released' | 'unavailable'

type GestureDependencies = {
  isEnabled: () => boolean
  isBusy: () => boolean
  isFocused: () => boolean
  isRecording: () => boolean
  quit: () => void
  notice: (notice: HoldQuitNotice) => void
  watch: (code: string, emit: (event: HoldQuitWatchEvent) => void) => () => void
}

export class HoldQuitGesture {
  private pending: { code: string; stop: () => void } | null = null
  private completed = false
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private phase: HoldQuitNotice['phase'] = 'dismissed'

  constructor(private readonly deps: GestureDependencies) {}

  input(input: HoldQuitInput): void {
    if (
      input.type === 'keyUp' &&
      (input.code === this.pending?.code ||
        input.key?.toLowerCase() === 'q' ||
        input.code?.startsWith('Meta') ||
        input.key === 'Meta' ||
        !input.meta)
    ) {
      this.completed = false
      if (this.pending) {
        this.release()
      }
      return
    }
    if (input.type !== 'keyDown') {
      return
    }
    if (!isHoldQuitChord(input)) {
      if (this.pending) {
        this.cancel()
      }
      return
    }
    if (!this.deps.isEnabled() || this.deps.isRecording() || !this.deps.isFocused()) {
      this.cancel()
      return
    }
    if (input.isAutoRepeat) {
      return
    }
    this.cancel()
    this.completed = false
    if (!this.deps.isBusy()) {
      this.completed = true
      this.deps.quit()
      return
    }
    const pending = { code: input.code ?? 'KeyQ', stop: (): void => {} }
    this.pending = pending
    this.publish('starting')
    const stop = this.deps.watch(input.code ?? 'KeyQ', (event) => {
      if (this.pending !== pending || this.completed) {
        return
      }
      if (!this.deps.isEnabled() || !this.deps.isFocused() || this.deps.isRecording()) {
        this.cancel()
        return
      }
      if (event === 'watching') {
        if (this.deps.isBusy()) {
          this.publish('holding')
        }
      } else if (event === 'held') {
        this.stopPending()
        this.completed = true
        this.dismiss()
        this.deps.quit()
      } else {
        this.release(event === 'unavailable' ? 'unavailable' : 'released')
      }
    })
    if (this.pending === pending) {
      pending.stop = stop
    } else {
      stop()
    }
  }

  refresh(): void {
    if (!this.deps.isEnabled() || this.deps.isRecording()) {
      this.cancel()
    } else if (!this.deps.isBusy()) {
      this.dismiss()
    }
  }

  cancel(): void {
    this.stopPending()
    this.completed = false
    this.dismiss()
  }

  private stopPending(): void {
    const pending = this.pending
    this.pending = null
    pending?.stop()
  }

  private release(phase: 'released' | 'unavailable' = 'released'): void {
    this.stopPending()
    if (!this.deps.isBusy()) {
      this.dismiss()
      return
    }
    this.publish(phase)
    this.hintTimer = setTimeout(() => this.dismiss(), 2000)
  }

  private dismiss(): void {
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer)
    }
    this.hintTimer = null
    this.publish('dismissed')
  }

  private publish(phase: HoldQuitNotice['phase']): void {
    if (phase === this.phase) {
      return
    }
    this.phase = phase
    this.deps.notice({ phase })
  }
}
