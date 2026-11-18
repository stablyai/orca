// Main-process counters installed through Playwright's main evaluate; identical on OLD and NEW builds.

/** Serialized into main by electronApp.evaluate, so it must not close over module scope. */
function installMainProbe({ app, ipcMain, webContents }) {
  if (globalThis.__fleetGateMain) {
    return 'already-installed'
  }
  const crypto = process.getBuiltinModule('node:crypto')
  const perfHooks = process.getBuiltinModule('node:perf_hooks')
  // Fields that advance without the payload changing anything the receiver shows.
  const VERSION_KEYS = new Set([
    'snapshotVersion',
    'version',
    'sequence',
    'seq',
    'revision',
    'generation',
    'publicationEpoch',
    'cursor',
    'updatedAt',
    'sentAt',
    'emittedAt',
    'timestamp',
    'ts'
  ])
  const state = {
    out: new Map(),
    in: new Map(),
    lastFingerprint: new Map(),
    stalls100: 0,
    stalls500: 0,
    stallMaxMs: 0,
    delay: perfHooks.monitorEventLoopDelay({ resolution: 10 })
  }
  state.delay.enable()
  const bump = (map, channel, bytes, noop) => {
    const row = map.get(channel) ?? { n: 0, bytes: 0, noop: 0 }
    row.n += 1
    row.bytes += bytes
    if (noop) {
      row.noop += 1
    }
    map.set(channel, row)
  }
  const findWorktreeId = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3) {
      return null
    }
    if (typeof value.worktreeId === 'string') {
      return value.worktreeId
    }
    for (const key of ['response', 'result', 'payload', 'snapshot', 'event']) {
      const found = findWorktreeId(value[key], depth + 1)
      if (found) {
        return found
      }
    }
    return null
  }
  const describe = (channel, args) => {
    let text
    try {
      text = JSON.stringify(args, (key, value) => (VERSION_KEYS.has(key) ? undefined : value))
    } catch {
      return { bytes: 0, noop: false }
    }
    if (typeof text !== 'string') {
      return { bytes: 0, noop: false }
    }
    const first = args[0]
    const identity = [
      channel,
      first && typeof first === 'object' ? (first.subscriptionId ?? '') : '',
      findWorktreeId(first, 0) ?? ''
    ].join('|')
    const fingerprint = crypto.createHash('sha1').update(text).digest('base64')
    const noop = state.lastFingerprint.get(identity) === fingerprint
    state.lastFingerprint.set(identity, fingerprint)
    return { bytes: text.length, noop }
  }
  const wrapContents = (contents) => {
    if (contents.__fleetGateWrapped) {
      return
    }
    contents.__fleetGateWrapped = true
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      const { bytes, noop } = describe(channel, args)
      bump(state.out, channel, bytes, noop)
      return send(channel, ...args)
    }
    const countIncoming = (_event, channel, ...args) => {
      let bytes = 0
      try {
        bytes = JSON.stringify(args)?.length ?? 0
      } catch {}
      bump(state.in, channel, bytes, false)
    }
    contents.on('ipc-message', countIncoming)
    contents.on('ipc-message-sync', countIncoming)
  }
  for (const contents of webContents.getAllWebContents()) {
    wrapContents(contents)
  }
  app.on('web-contents-created', (_event, contents) => wrapContents(contents))
  // invoke() has no public event; wrap the handler table so every channel, present or later, is counted.
  const handlers = ipcMain._invokeHandlers
  let invokeCounted = false
  if (handlers instanceof Map) {
    const wrapHandler = (channel, handler) => {
      if (handler.__fleetGateWrapped) {
        return handler
      }
      const wrapped = (event, ...args) => {
        let bytes = 0
        try {
          bytes = JSON.stringify(args)?.length ?? 0
        } catch {}
        bump(state.in, channel, bytes, false)
        return handler(event, ...args)
      }
      wrapped.__fleetGateWrapped = true
      return wrapped
    }
    for (const [channel, handler] of handlers) {
      handlers.set(channel, wrapHandler(channel, handler))
    }
    const set = handlers.set.bind(handlers)
    handlers.set = (channel, handler) => set(channel, wrapHandler(channel, handler))
    invokeCounted = true
  }
  const TICK_MS = 50
  let expected = performance.now() + TICK_MS
  const ticker = setInterval(() => {
    const now = performance.now()
    const late = now - expected
    expected = now + TICK_MS
    if (late > 100) {
      state.stalls100 += 1
    }
    if (late > 500) {
      state.stalls500 += 1
    }
    state.stallMaxMs = Math.max(state.stallMaxMs, late)
  }, TICK_MS)
  ticker.unref?.()
  globalThis.__fleetGateMain = {
    reset() {
      state.out.clear()
      state.in.clear()
      state.stalls100 = 0
      state.stalls500 = 0
      state.stallMaxMs = 0
      state.delay.reset()
    },
    snapshot() {
      const rows = (map) =>
        Object.fromEntries([...map.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25))
      const sum = (map, key) => [...map.values()].reduce((total, row) => total + row[key], 0)
      return {
        invokeCounted,
        out: {
          n: sum(state.out, 'n'),
          bytes: sum(state.out, 'bytes'),
          noop: sum(state.out, 'noop')
        },
        in: { n: sum(state.in, 'n'), bytes: sum(state.in, 'bytes') },
        outByChannel: rows(state.out),
        inByChannel: rows(state.in),
        stalls100: state.stalls100,
        stalls500: state.stalls500,
        stallMaxMs: Math.round(state.stallMaxMs),
        loopDelayP99Ms: Math.round(state.delay.percentile(99) / 1e6),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576)
      }
    }
  }
  return invokeCounted ? 'installed' : 'installed-without-invoke'
}

// Playwright occasionally drops an evaluate promise in a freshly started main process; one retry clears it.
export async function installMainProbeIn(electronApp) {
  return electronApp.evaluate(installMainProbe).catch(() => electronApp.evaluate(installMainProbe))
}

export async function resetMainProbe(electronApp) {
  await electronApp.evaluate(() => globalThis.__fleetGateMain.reset())
}

export async function snapshotMainProbe(electronApp) {
  return electronApp.evaluate(() => globalThis.__fleetGateMain.snapshot())
}
