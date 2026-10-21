import type { Image, ImageLoadEvent, View } from 'react-native'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'
import type { FrameLayer } from './mobile-browser-frame-state'
import { createBrowserFrameDataUri } from './browser-frame-data-uri'
import {
  updateBrowserImageSource,
  updateBrowserLayerVisibility,
  whenBrowserFrameDisplayable
} from './browser-frame-layer-paint'

type QueuedFrame = { frame: BrowserScreencastFrame; cacheKey: string }
type ShownBrowserFrame = QueuedFrame & { uri: string }

/** What a layer's Image holds natively, and whether that source has answered yet. */
type LayerState = { uri: string | null; status: 'loading' | 'ready' | 'failed' }

type BrowserFramePacerDeps = {
  initialUri: string | null
  /** The source the layers mount with; later frames are written natively. */
  setFrameUri: (uri: string | null) => void
  onShown: (shown: ShownBrowserFrame) => void
}

/** What one layer's `<View>` and `<Image>` hand the pacer. Stable, so binding them re-renders nothing. */
export type BrowserFrameLayerBinding = {
  attachView: (view: View | null) => void
  attachImage: (image: Image | null) => void
  onLoad: (event: ImageLoadEvent) => void
  onError: () => void
}

/**
 * Owns the pane's double buffer: each frame decodes on the hidden layer and is shown by flipping
 * opacity once it has, at most one frame per interval.
 *
 * The stream writes a layer only when it is not loading and only with a different source, so every
 * write gets exactly one native answer: an unchanged source reloads nothing on Android or iOS.
 * `replace` writes over a loading layer; the new source is the one that answers.
 */
export function createBrowserFramePacer(deps: BrowserFramePacerDeps) {
  const views: [View | null, View | null] = [null, null]
  const images: [Image | null, Image | null] = [null, null]
  const layers: [LayerState, LayerState] = [
    { uri: deps.initialUri, status: 'ready' },
    { uri: deps.initialUri, status: 'ready' }
  ]
  let mountedUri = deps.initialUri
  let visible: FrameLayer = 0
  // The frame to show once the hidden layer has decoded it.
  let target: ShownBrowserFrame | null = null
  let queued: QueuedFrame | null = null
  let lastAppliedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const hiddenLayer = (): FrameLayer => (visible === 0 ? 1 : 0)

  function write(layer: FrameLayer, uri: string): void {
    if (layers[layer].uri === uri) {
      return
    }
    layers[layer] = { uri, status: 'loading' }
    updateBrowserImageSource(images[layer], uri)
    awaitDecode(layer, uri)
  }

  // Why: a web `background-image` write fires no load event; native answers through onLoad.
  function awaitDecode(layer: FrameLayer, uri: string): void {
    whenBrowserFrameDisplayable(uri, {
      onDisplayable: () => settle(layer, uri),
      onUndecodable: () => {
        if (layers[layer].uri === uri) {
          fail(layer)
        }
      }
    })
  }

  function flip(layer: FrameLayer, shown: ShownBrowserFrame): void {
    target = null
    visible = layer
    updateBrowserLayerVisibility(views, layer)
    deps.onShown(shown)
  }

  function settle(layer: FrameLayer, uri: string | undefined): void {
    if (layers[layer].uri !== uri) {
      return
    }
    layers[layer].status = 'ready'
    if (target?.uri === uri && layer !== visible) {
      flip(layer, target)
    }
    drain()
  }

  function fail(layer: FrameLayer): void {
    layers[layer].status = 'failed'
    if (target?.uri === layers[layer].uri) {
      target = null
    }
    drain()
  }

  function show({ frame, cacheKey }: QueuedFrame): void {
    const shown = { frame, cacheKey, uri: createBrowserFrameDataUri(frame) }
    if (mountedUri === null) {
      mountedUri = shown.uri
      deps.setFrameUri(shown.uri)
      write(0, shown.uri)
      write(1, shown.uri)
      deps.onShown(shown)
      return
    }
    const hidden = hiddenLayer()
    const layer = layers[hidden]
    if (layer.uri !== shown.uri) {
      target = shown
      write(hidden, shown.uri)
    } else if (layer.status === 'ready') {
      // Why: an unchanged source reloads nothing, so it flips now (caret blink).
      flip(hidden, shown)
    }
    // A frame that already failed to decode is skipped rather than retried.
  }

  // Why: never cut a decode short; re-pointing an Android layer mid-decode stalls flips under load.
  function drain(): void {
    if (timer !== null || queued === null || layers[hiddenLayer()].status === 'loading') {
      return
    }
    const wait = lastAppliedAt + MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null
        drain()
      }, wait)
      return
    }
    const next = queued
    queued = null
    lastAppliedAt = Date.now()
    show(next)
  }

  // Why: static UI changes can be the last frame Chromium emits, so the newest is held, not dropped.
  function push(frame: BrowserScreencastFrame, cacheKey: string): void {
    queued = { frame, cacheKey }
    drain()
  }

  /** Drops every queued or timed frame; a load already under way still answers for its layer. */
  function reset(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    queued = null
    target = null
    lastAppliedAt = 0
  }

  /** Resets and puts `uri` on both layers, or unmounts them. */
  function replace(uri: string | null): void {
    reset()
    visible = 0
    updateBrowserLayerVisibility(views, visible)
    mountedUri = uri
    deps.setFrameUri(uri)
    if (uri === null) {
      layers[0] = { uri: null, status: 'ready' }
      layers[1] = { uri: null, status: 'ready' }
      return
    }
    write(0, uri)
    write(1, uri)
  }

  function bindLayer(layer: FrameLayer): BrowserFrameLayerBinding {
    return {
      attachView: (view) => {
        views[layer] = view
        updateBrowserLayerVisibility(views, visible)
      },
      attachImage: (image) => {
        images[layer] = image
        if (image === null || mountedUri === null) {
          return
        }
        // A fresh Image loads the source it mounted with; put back the one this layer held.
        const held = layers[layer].uri
        layers[layer] = { uri: mountedUri, status: 'loading' }
        awaitDecode(layer, mountedUri)
        if (held !== null) {
          write(layer, held)
        }
      },
      // Why: RN Web's own load event carries no source, so the web settles only through its probe.
      onLoad: (event) => settle(layer, event.nativeEvent.source?.uri),
      onError: () => fail(layer)
    }
  }

  return {
    hasFrame: (): boolean => mountedUri !== null,
    layers: [bindLayer(0), bindLayer(1)] as const,
    push,
    replace,
    reset
  }
}
