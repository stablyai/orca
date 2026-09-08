export function installMainBlockingProbe() {
  if (globalThis.__orcaMainBlockingProbe) {
    throw new Error('Main blocking probe already exists')
  }
  const events = []
  const cleanup = []
  const startedAt = Date.now()
  function wrap(object, name, label, sizeOf) {
    const original = object[name]
    const wrapped = function (...args) {
      const start = performance.now()
      const epoch = Date.now()
      let result
      try {
        result = Reflect.apply(original, this, args)
        return result
      } finally {
        const durationMs = performance.now() - start
        if (durationMs >= 8 && events.length < 2000) {
          events.push({
            epoch,
            durationMs,
            label,
            size: sizeOf?.(args, result) ?? null,
            stack: new Error('Main blocking call').stack?.split('\n').slice(2, 10)
          })
        }
      }
    }
    object[name] = wrapped
    cleanup.push(() => {
      if (object[name] === wrapped) {
        object[name] = original
      }
    })
  }
  wrap(JSON, 'stringify', 'JSON.stringify', (_args, result) => result?.length)
  wrap(globalThis, 'structuredClone', 'structuredClone')
  wrap(Buffer, 'from', 'Buffer.from', (args) => args[0]?.length)
  const hashPrototype = Object.getPrototypeOf(
    process.getBuiltinModule('crypto').createHash('sha256')
  )
  wrap(hashPrototype, 'update', 'hash.update', (args) => args[0]?.length)
  const fs = process.getBuiltinModule('fs')
  for (const name of ['existsSync', 'accessSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
    wrap(fs, name, name)
  }
  const timerGaps = []
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - previous - 25
    previous = now
    if (gap > 20 && timerGaps.length < 2000) {
      timerGaps.push({ epoch: Date.now(), gapMs: gap })
    }
  }, 25)
  timer.unref()
  globalThis.__orcaMainBlockingProbe = {
    stop() {
      clearInterval(timer)
      for (const restore of cleanup.toReversed()) {
        restore()
      }
      delete globalThis.__orcaMainBlockingProbe
      return { startedAt, endedAt: Date.now(), events, timerGaps }
    }
  }
  return { startedAt }
}

export function installRendererIpcProbe() {
  if (window.__orcaIpcTimingProbe) {
    throw new Error('Renderer IPC probe already exists')
  }
  const requests = []
  const keys = []
  let pending = false
  let stopped = false
  const timer = setInterval(async () => {
    if (pending || stopped) {
      return
    }
    pending = true
    const start = performance.now()
    const epoch = Date.now()
    try {
      await window.api.app.getIdentity()
      if (requests.length < 2000) {
        requests.push({ epoch, durationMs: performance.now() - start })
      }
    } finally {
      pending = false
    }
  }, 100)
  const keydown = (event) => {
    if (keys.length < 1000) {
      keys.push({
        epoch: Date.now(),
        queueMs: performance.now() - event.timeStamp,
        terminal: !!event.target?.closest?.('.xterm'),
        trusted: event.isTrusted
      })
    }
  }
  document.addEventListener('keydown', keydown, true)
  window.__orcaIpcTimingProbe = {
    stop() {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('keydown', keydown, true)
      delete window.__orcaIpcTimingProbe
      return { requests, keys }
    }
  }
}
