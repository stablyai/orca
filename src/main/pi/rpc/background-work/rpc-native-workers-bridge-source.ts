export const PI_NATIVE_WORKERS_STATUS_KEY = 'orca-native-workers'

/** Loaded only by the GUI RPC bridge; event hints schedule reads, never worker actions. */
export function getPiNativeWorkersBridgeSource(): string {
  return String.raw`
function observeNativeWorkers(pi, ctx, instance) {
  let live = true
  let sequence = 0
  let generation = 0
  let dirty = false
  let timer = null
  let reading = false
  let discovering = false
  let rediscover = false
  let subscribed = false
  const disposers = []
  const requests = new Set()
  const sessionId = ctx.sessionManager.getSessionId()
  const current = () => live && ctx.sessionManager.getSessionId() === sessionId
  const publish = (state, asyncSnapshot) => {
    if (!current()) return
    const packet = { version: 1, instance, sequence: ++sequence, state, asyncSnapshot }
    let encoded = JSON.stringify(packet)
    if (Buffer.byteLength(encoded) > 64 * 1024) encoded = JSON.stringify({ version: 1, instance, sequence, state: 'unknown' })
    try { ctx.ui.setStatus('orca-native-workers', encoded) } catch {}
  }
  const request = (method) => new Promise((resolve) => {
    const requestId = require('crypto').randomUUID()
    let settled = false
    let timeout
    let unsubscribe = () => {}
    const finish = (data) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      requests.delete(cancel)
      resolve(data)
    }
    const cancel = () => finish(null)
    requests.add(cancel)
    unsubscribe = pi.events.on('subagents:rpc:v1:reply:' + requestId, (reply) => {
      if (reply?.version === 1 && reply.requestId === requestId) finish(reply.success === true ? reply.data : null)
    })
    timeout = setTimeout(cancel, 5000)
    timeout.unref?.()
    try { pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method }) } catch { cancel() }
  })
  const refresh = () => {
    if (!current()) return
    dirty = true
    if (!subscribed || reading || timer || discovering) return
    timer = setTimeout(async () => {
      timer = null
      if (!current()) return
      reading = true
      dirty = false
      const started = generation
      try {
        const data = await request('status')
        if (current() && started === generation) publish(data?.asyncSnapshot ? 'known' : 'unknown', data?.asyncSnapshot)
      } catch {
        if (current() && started === generation) publish('unknown')
      } finally {
        reading = false
        if (current() && dirty) refresh()
      }
    }, 250)
    timer.unref?.()
  }
  const discover = async () => {
    if (!current()) return
    if (discovering) { rediscover = true; return }
    discovering = true
    generation++
    clearTimeout(timer)
    timer = null
    publish('unknown')
    try {
      const ping = await request('ping')
      if (!current()) return
      if (ping?.capabilities?.asyncStatusSnapshot?.version !== 1) return
      if (!subscribed) {
        const events = ping.events
        for (const name of ['jobsChanged', 'asyncStarted', 'childStatus', 'asyncComplete', 'processTerminal']) {
          const event = events?.[name]
          if (typeof event !== 'string' || !event || event.length > 128) return
        }
        for (const name of ['jobsChanged', 'asyncStarted', 'childStatus', 'asyncComplete', 'processTerminal']) {
          disposers.push(pi.events.on(events[name], refresh))
        }
        subscribed = true
      }
      refresh()
    } catch {
      publish('unknown')
    } finally {
      discovering = false
      if (rediscover && current()) { rediscover = false; void discover() }
      else if (current() && dirty) refresh()
    }
  }
  disposers.push(pi.events.on('subagents:rpc:v1:ready', () => { void discover() }))
  void discover()
  return () => {
    live = false
    clearTimeout(timer)
    for (const cancel of requests) cancel()
    for (const dispose of disposers) dispose()
  }
}
`
}
