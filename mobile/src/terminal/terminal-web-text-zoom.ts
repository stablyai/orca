import type { Terminal } from '@xterm/xterm'
import type { MobileWebTerminalTextScale } from '../../../src/shared/mobile-web/native-operation-contract'
import { TERMINAL_TEXT_SCALES } from '../storage/preferences'
import type { TerminalWebViewProps } from './terminal-webview-contract'

type TextZoomControllerOptions = {
  container: HTMLElement
  terminal: Terminal
  getProps: () => TerminalWebViewProps
  onPinchStart: () => void
}

export function createTerminalWebTextZoomController({
  container,
  terminal,
  getProps,
  onPinchStart
}: TextZoomControllerOptions) {
  let initialDistance = 0
  let initialTextScale = 1
  let transientScale = 1
  let pinching = false

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      return
    }
    initialDistance = touchDistance(event.touches[0]!, event.touches[1]!)
    if (initialDistance <= 0) {
      return
    }
    initialTextScale = getProps().textScale ?? 1
    transientScale = 1
    pinching = true
    onPinchStart()
    event.preventDefault()
  }

  const move = (event: TouchEvent) => {
    if (!pinching || event.touches.length !== 2) {
      return
    }
    const distance = touchDistance(event.touches[0]!, event.touches[1]!)
    transientScale =
      clampTextScale(initialTextScale * (distance / initialDistance)) / initialTextScale
    if (terminal.element) {
      terminal.element.style.transformOrigin = 'center center'
      terminal.element.style.transform = `scale(${transientScale})`
    }
    event.preventDefault()
  }

  const finish = (event: TouchEvent) => {
    if (!pinching || event.touches.length >= 2) {
      return
    }
    pinching = false
    if (terminal.element) {
      terminal.element.style.transform = ''
      terminal.element.style.transformOrigin = ''
    }
    const target = snapTerminalTextScale(initialTextScale * transientScale)
    getProps().onTextScaleChange?.(target)
    if (target !== initialTextScale) {
      getProps().onHaptic?.('selection')
    }
  }

  container.addEventListener('touchstart', start, { passive: false })
  container.addEventListener('touchmove', move, { passive: false })
  container.addEventListener('touchend', finish)
  container.addEventListener('touchcancel', finish)

  return {
    dispose() {
      container.removeEventListener('touchstart', start)
      container.removeEventListener('touchmove', move)
      container.removeEventListener('touchend', finish)
      container.removeEventListener('touchcancel', finish)
    }
  }
}

export function snapTerminalTextScale(value: number): MobileWebTerminalTextScale {
  return TERMINAL_TEXT_SCALES.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  )
}

function clampTextScale(value: number): number {
  return Math.max(TERMINAL_TEXT_SCALES[0], Math.min(TERMINAL_TEXT_SCALES.at(-1)!, value))
}

function touchDistance(left: Touch, right: Touch): number {
  return Math.hypot(left.clientX - right.clientX, left.clientY - right.clientY)
}
