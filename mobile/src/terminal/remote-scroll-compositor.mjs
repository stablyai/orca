import {
  canPresentRemoteScroll,
  findRemoteScrollRegion,
  remoteScrollFrameIdentity,
  remoteScrollTranslation,
  remoteScrollRows
} from './remote-scroll-region.mjs'

// Why: a program that owns a mouse-tracking screen (Claude Code, Codex) answers a wheel report by
// redrawing whole rows, so its body jumped a row per report while the finger moved smoothly. Once
// the next frame confirms which rows moved, that body is drawn sliding from where it was to where
// it is over 40ms on a canvas above the grid; a fixed header or input line is never part of the
// slide. The program's own frame is what stays on screen: this only paints over it meanwhile.
const controllers = new WeakMap()

function createController(terminal) {
  let history = null,
    rows = null,
    base = null,
    prior = null,
    strip = null,
    holder = null,
    animation = null,
    hideTimer = null
  let expires = 0,
    direction = 0,
    idleTimer = null,
    caughtTouch = false
  let frameIdentity = '',
    frameSource = null
  const document = terminal.element.ownerDocument
  const reducedMotion = () =>
    document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches
  function stopAnimation() {
    clearTimeout(hideTimer)
    hideTimer = null
    animation = null
    if (holder) {
      holder.style.display = 'none'
    }
  }
  function reset() {
    stopAnimation()
    history = null
    rows = null
    frameIdentity = ''
    frameSource = null
    holder?.remove()
    for (const canvas of [base, prior, strip]) {
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    base = prior = strip = holder = null
  }
  function ensure(source, screen) {
    if (base?.width === source.width && base?.height === source.height) {
      return
    }
    reset()
    base = document.createElement('canvas')
    prior = document.createElement('canvas')
    strip = document.createElement('canvas')
    holder = document.createElement('div')
    holder.className = 'orca-remote-scroll-presentation'
    holder.setAttribute('aria-hidden', 'true')
    for (const c of [base, prior]) {
      c.width = source.width
      c.height = source.height
    }
    holder.style.cssText =
      'position:absolute;left:0;overflow:hidden;pointer-events:none;z-index:3;display:none'
    holder.style.width = source.style.width
    holder.style.backgroundColor = terminal.options?.theme?.background || '#000000'
    strip.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;pointer-events:none'
    holder.appendChild(strip)
    screen.appendChild(holder)
  }
  function render() {
    const term = terminal
    if (
      performance.now() > expires ||
      !canPresentRemoteScroll(term) ||
      document.visibilityState !== 'visible' ||
      reducedMotion()
    ) {
      reset()
      return
    }
    const renderer = term._core._renderService._renderer.value,
      source = renderer._canvas
    if (!source || !renderer._gl) {
      reset()
      return
    }
    if (
      !(source.width > 0 && source.height > 0 && renderer.dimensions.css.cell.height > 0) ||
      source.width * source.height * 3 > 16 * 1024 * 1024
    ) {
      reset()
      return
    }
    const identity = remoteScrollFrameIdentity(term, renderer)
    if (base && (frameIdentity !== identity || frameSource !== source)) {
      reset()
    }
    ensure(source, term._core.screenElement)
    frameIdentity = identity
    frameSource = source
    const next = remoteScrollRows(term)
    if (!next) {
      reset()
      return
    }
    if (
      history &&
      rows &&
      next
        .slice(history.start, history.end + 1)
        .every((row, i) => row.key === rows[history.start + i].key)
    ) {
      rows = next
      return
    }
    const movement = findRemoteScrollRegion(rows, next, direction),
      ratio = source.width / Number.parseFloat(source.style.width)
    const top = movement ? movement.start * renderer.dimensions.css.cell.height * ratio : 0
    const height = movement
      ? (movement.end - movement.start + 1) * renderer.dimensions.css.cell.height * ratio
      : 0
    const compatible =
      animation && movement && animation.start === movement.start && animation.end === movement.end
    const offset = compatible ? remoteScrollTranslation(strip) : 0
    const remaining = compatible ? (offset - animation.final) * ratio : 0
    const sameHistory =
      movement && history && history.start === movement.start && history.end === movement.end
    const deltaPixels = movement ? movement.delta * renderer.dimensions.css.cell.height * ratio : 0
    const pad = Math.min(16, term.rows) * renderer.dimensions.css.cell.height * ratio
    const totalHeight = height + 2 * pad
    if (source.width * (2 * totalHeight + source.height) > 16 * 1024 * 1024) {
      reset()
      return
    }
    if (movement) {
      if (prior.width !== source.width || prior.height !== totalHeight) {
        prior.width = source.width
        prior.height = totalHeight
      }
      const ctx = prior.getContext('2d')
      ctx.clearRect(0, 0, prior.width, prior.height)
      if (sameHistory) {
        ctx.drawImage(strip, 0, deltaPixels)
      } else {
        ctx.drawImage(base, 0, top, base.width, height, 0, pad + deltaPixels, base.width, height)
      }
    }
    stopAnimation()
    const baseContext = base.getContext('2d')
    baseContext.clearRect(0, 0, base.width, base.height)
    baseContext.drawImage(source, 0, 0)
    rows = next
    if (movement) {
      prior.getContext('2d').clearRect(0, pad, base.width, height)
      prior.getContext('2d').drawImage(base, 0, top, base.width, height, 0, pad, base.width, height)
      const oldStrip = strip
      strip = prior
      prior = oldStrip
      strip.style.cssText =
        'position:absolute;left:0;top:0;will-change:transform;pointer-events:none'
      strip.style.width = source.style.width
      strip.style.height = totalHeight / ratio + 'px'
      holder.replaceChildren(strip)
      holder.style.top = top / ratio + 'px'
      holder.style.height = height / ratio + 'px'
      holder.style.display = 'block'
      const initial = (-pad + remaining - deltaPixels) / ratio,
        final = -pad / ratio
      const oldTop = sameHistory ? history.topAvailable : 0,
        oldBottom = sameHistory ? history.bottomAvailable : 0
      history = {
        ...movement,
        pad,
        top,
        height,
        topAvailable: Math.min(pad, Math.max(0, oldTop - deltaPixels)),
        bottomAvailable: Math.min(pad, Math.max(0, oldBottom + deltaPixels))
      }
      const startOffset = remaining - deltaPixels
      if (startOffset < -history.bottomAvailable || startOffset > history.topAvailable) {
        holder.style.display = 'none'
      } else {
        strip.style.transition = 'none'
        strip.style.transform = `translateY(${initial}px)`
        void strip.offsetWidth
        strip.style.transition = 'transform 40ms linear'
        strip.style.transform = `translateY(${final}px)`
        animation = { ...movement, final, distance: deltaPixels - remaining }
        hideTimer = setTimeout(stopAnimation, 55)
      }
    } else {
      holder.style.display = 'none'
      history = null
    }
  }

  const cancel = (event) => {
    caughtTouch = event?.type === 'touchstart' && Boolean(animation)
    expires = 0
    clearTimeout(idleTimer)
    reset()
  }
  const renderSafely = () => {
    try {
      render()
    } catch {
      cancel()
    }
  }
  const subscription = terminal.onRender(renderSafely)
  const events = ['touchstart', 'touchcancel', 'keydown', 'visibilitychange']
  for (const event of events) {
    document.addEventListener(event, cancel, true)
  }
  const wheel = (event) => {
    if (event.ctrlKey) {
      cancel()
    }
  }
  document.addEventListener('wheel', wheel, true)
  return {
    begin(lines) {
      if (!Number.isFinite(lines) || !lines || reducedMotion()) {
        cancel()
        return
      }
      const nextDirection = -Math.sign(lines)
      if (direction && direction !== nextDirection) {
        reset()
      }
      direction = nextDirection
      expires = performance.now() + 350
      clearTimeout(idleTimer)
      idleTimer = setTimeout(cancel, 350)
      if (!base) {
        // Capture the old grid before the leading input leaves, even between WebGL frames.
        terminal._core._renderService._renderer.value.renderRows(0, terminal.rows - 1)
        renderSafely()
      }
    },
    cancel,
    consumeTouchCatch() {
      const caught = caughtTouch
      caughtTouch = false
      return caught
    },
    dispose() {
      cancel()
      subscription.dispose()
      for (const event of events) {
        document.removeEventListener(event, cancel, true)
      }
      document.removeEventListener('wheel', wheel, true)
    }
  }
}

/**
 * xterm's terminal with the document's remote scroll presentation seams.
 * @template T
 * @param {T} BaseTerminal
 * @returns {T}
 */
export function createRemoteScrollTerminal(BaseTerminal) {
  return class RemoteScrollTerminal extends BaseTerminal {
    beginRemoteScrollPresentation(lines) {
      beginRemoteScrollPresentation(this, lines)
    }
    consumeRemoteScrollTouchCatch() {
      return consumeRemoteScrollTouchCatch(this)
    }
    reset() {
      cancelRemoteScrollPresentation(this)
      super.reset()
    }
    resize(cols, rows) {
      cancelRemoteScrollPresentation(this)
      super.resize(cols, rows)
    }
    dispose() {
      disposeRemoteScrollPresentation(this)
      super.dispose()
    }
  }
}

/** Starts or extends a slide for `lines` of wheel input sent to the program. */
export function beginRemoteScrollPresentation(terminal, lines) {
  // Presentation failure must never consume or delay the actual terminal input.
  try {
    if (!canPresentRemoteScroll(terminal)) {
      controllers.get(terminal)?.cancel()
      return
    }
    let controller = controllers.get(terminal)
    if (!controller) {
      controller = createController(terminal)
      controllers.set(terminal, controller)
    }
    controller.begin(lines)
  } catch {
    controllers.get(terminal)?.cancel()
  }
}

export function cancelRemoteScrollPresentation(terminal) {
  controllers.get(terminal)?.cancel()
}

export function disposeRemoteScrollPresentation(terminal) {
  controllers.get(terminal)?.dispose()
  controllers.delete(terminal)
}

/** Whether the last touch only stopped a running slide, which then must not also tap. */
export function consumeRemoteScrollTouchCatch(terminal) {
  return controllers.get(terminal)?.consumeTouchCatch() ?? false
}
