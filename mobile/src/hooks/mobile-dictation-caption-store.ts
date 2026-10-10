import { useSyncExternalStore } from 'react'

/**
 * The live caption outside React state.
 * Why: captions change several times a second; only the views that paint them should re-render,
 * not the whole session tree that owns the dictation.
 */
export class MobileDictationCaptionStore {
  private text = ''
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): string => this.text

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(text: string): void {
    if (text === this.text) {
      return
    }
    this.text = text
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const noCaptionSubscribe = () => () => {}
const noCaption = () => ''

/** The caption to paint; '' when there is no store (desktops without live captions, tests). */
export function useMobileDictationCaption(store: MobileDictationCaptionStore | undefined): string {
  return useSyncExternalStore(
    store?.subscribe ?? noCaptionSubscribe,
    store?.getSnapshot ?? noCaption,
    store?.getSnapshot ?? noCaption
  )
}
