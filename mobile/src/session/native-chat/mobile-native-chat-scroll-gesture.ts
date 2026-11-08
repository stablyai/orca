export function connectMobileNativeChatScrollGesture(
  viewport: HTMLElement,
  onStart: () => void,
  onEnd: () => void
) {
  const document = viewport.ownerDocument
  const pointers = new Set<number>()
  const touchPointers = new Set<number>()
  const touchTargets = new Set<EventTarget>()
  let contacts = 0
  let inputSession = false
  let version = 0
  const active = () => contacts > 0 || pointers.size > 0 || touchPointers.size > 0
  const start = () => {
    inputSession = true
    version += 1
    onStart()
  }
  const onMove = () => {
    if (active()) {
      inputSession = true
      version += 1
    }
  }
  const onWheel = () => {
    start()
    onEnd()
  }
  const onKey = (event: KeyboardEvent) => {
    const target = event.target
    const editable =
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea, [contenteditable="true"]'))
    if (
      event.key === 'Tab' ||
      (!editable &&
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
    ) {
      start()
      onEnd()
    }
  }
  const releaseTargets = () => {
    for (const target of touchTargets) {
      target.removeEventListener('touchend', onTouchEnd, true)
      target.removeEventListener('touchcancel', onTouchEnd, true)
    }
    touchTargets.clear()
  }
  const endTouch = (pointerEnded = false) => {
    const wasTouching = pointerEnded || contacts > 0 || touchPointers.size > 0
    contacts = 0
    touchPointers.clear()
    releaseTargets()
    if (wasTouching && !active()) {
      onEnd()
    }
  }
  const onTouchEnd = (event: Event) => {
    if (event instanceof TouchEvent && event.touches.length > 0) {
      contacts = event.touches.length
      return
    }
    endTouch()
  }
  const onTouchStart = (event: TouchEvent) => {
    contacts = event.touches.length
    start()
    const target = event.target
    if (target && !touchTargets.has(target)) {
      target.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
      target.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true })
      touchTargets.add(target)
    }
  }
  const onPointerStart = (event: PointerEvent) => {
    const activePointers = event.pointerType === 'touch' ? touchPointers : pointers
    activePointers.add(event.pointerId)
    start()
  }
  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      if (
        event.type === 'pointerup' &&
        touchPointers.delete(event.pointerId) &&
        touchPointers.size === 0
      ) {
        endTouch(true)
      }
    } else if (pointers.delete(event.pointerId) && !active()) {
      onEnd()
    }
  }
  viewport.addEventListener('pointerdown', onPointerStart, { passive: true })
  viewport.addEventListener('touchstart', onTouchStart, { passive: true })
  viewport.addEventListener('pointermove', onMove, { passive: true })
  viewport.addEventListener('touchmove', onMove, { passive: true })
  viewport.addEventListener('wheel', onWheel, { passive: true })
  viewport.addEventListener('keydown', onKey)
  document.addEventListener('pointerup', onPointerEnd, { passive: true })
  document.addEventListener('pointercancel', onPointerEnd, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { passive: true })
  return {
    active,
    navigating: () => inputSession,
    version: () => version,
    settled: () => {
      if (!active()) {
        inputSession = false
      }
    },
    dispose: () => {
      releaseTargets()
      pointers.clear()
      touchPointers.clear()
      contacts = 0
      viewport.removeEventListener('pointerdown', onPointerStart)
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('touchmove', onMove)
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerup', onPointerEnd)
      document.removeEventListener('pointercancel', onPointerEnd)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
  }
}
