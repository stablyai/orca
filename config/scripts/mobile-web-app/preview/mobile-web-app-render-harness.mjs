import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { contentTypeForExtension } from '../../mobile-web-bundle-manifest.mjs'
import { fileURLToPath } from 'node:url'

export const projectDir = fileURLToPath(new URL('../../../..', import.meta.url))

// Drop full-line comments before parsing quoted Kotlin CSP directives; comments also quote directive text.
export function parseCspDirectives(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start === -1 || end < start) {
    throw new Error(`could not find ${startMarker} .. ${endMarker}`)
  }
  const body = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  const directives = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (directives.length < 10) {
    throw new Error('could not parse the shell CSP')
  }
  return directives.join('; ')
}

// Read shipped Kotlin CSP; copied fixture can drift and JVM constant cannot be imported here.
export async function readShellCsp() {
  const source = await readFile(
    join(
      projectDir,
      'mobile/modules/orca-mobile-web-shell/android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellCsp.kt'
    ),
    'utf8'
  )
  return parseCspDirectives(source, 'listOf(', ').joinToString')
}

// Read literal document headers from Kotlin; CSP constant stays readShellCsp’s job. Throw if none found or browser defaults could masquerade as shell guarantees.
export async function readShellDocumentHeaders() {
  const source = await readFile(
    join(
      projectDir,
      'mobile/modules/orca-mobile-web-shell/android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellResponseHeaders.kt'
    ),
    'utf8'
  )
  const start = source.indexOf('if (path == "/")')
  const end = source.indexOf('return headers', start)
  if (start === -1 || end < start) {
    throw new Error('could not find the shell document-header branch')
  }
  const headers = {}
  for (const match of source.slice(start, end).matchAll(/headers\["([^"]+)"\] = "([^"]+)"/g)) {
    headers[match[1]] = match[2]
  }
  if (Object.keys(headers).length === 0) {
    throw new Error('could not parse the shell document headers')
  }
  return headers
}

// Read protocol version from contract; copied stale version would hide behind mount timeout.
export async function readBridgeProtocolVersion() {
  // Read declaring module rather than envelope reexport so source splits cannot silently change reader target.
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-frame-fields.ts'),
    'utf8'
  )
  const match = /BRIDGE_PROTOCOL_VERSION = (\d+)/.exec(source)
  if (!match) {
    throw new Error('could not read BRIDGE_PROTOCOL_VERSION from bridge-frame-fields.ts')
  }
  return Number(match[1])
}

// Read actual bridge window caps, including product expression, so double prices frames identically after host changes.
export async function readBridgeWindowCaps() {
  const sources = await Promise.all(
    [
      'src/shared/mobile-bridge-frame-bytes.ts',
      'mobile/src/mobile-web-shell/bridge-host-subscriptions.ts'
    ].map((path) => readFile(join(projectDir, path), 'utf8'))
  )
  const source = sources.join('\n')
  const read = (name) => {
    const match = new RegExp(`${name} = ([0-9*\\s]+)`).exec(source)
    if (!match) {
      throw new Error(`could not read ${name}`)
    }
    return match[1]
      .split('*')
      .map((part) => Number(part.trim()))
      .reduce((product, factor) => product * factor, 1)
  }
  return {
    maxMessageBytes: read('MOBILE_BRIDGE_MAX_FRAME_BYTES'),
    maxUnackedFrames: read('BRIDGE_MAX_UNACKED_FRAMES'),
    maxUnackedBytes: read('BRIDGE_MAX_UNACKED_BYTES')
  }
}

// Read upload base64 chunk cap/product from source; copied resize budget could pass after upload path changes.
export async function readClipboardImageUploadChunkBase64Chars() {
  const source = await readFile(
    join(projectDir, 'mobile/src/session/mobile-clipboard-image-upload-chunk.ts'),
    'utf8'
  )
  const match = /MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = ([0-9*\s]+)/.exec(source)
  if (!match) {
    throw new Error('could not read MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS')
  }
  return match[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((product, factor) => product * factor, 1)
}

// Read shipped screencast JPEG quality; copied value would certify budget for an encoder configuration no product uses.
export async function readBrowserFrameQuality() {
  const source = await readFile(
    join(projectDir, 'mobile/src/browser/browser-screencast-request-parameters.ts'),
    'utf8'
  )
  const match = /BROWSER_FRAME_QUALITY = (\d+)/.exec(source)
  if (!match) {
    throw new Error('could not read BROWSER_FRAME_QUALITY')
  }
  return Number(match[1]) / 100
}

// Read page client-identity placeholder from declaration so rig cannot silently retain stale copy.
export async function readBridgePageClientIdentity() {
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-page-client-identity.ts'),
    'utf8'
  )
  const read = (name) => {
    const match = new RegExp(`${name} = '([^']+)'`).exec(source)
    if (!match) {
      throw new Error(`could not read ${name} from bridge-page-client-identity.ts`)
    }
    return match[1]
  }
  return { placeholder: read('BRIDGE_PAGE_CLIENT_ID') }
}

export async function readBridgeFaultGrant() {
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-frame-fields.ts'),
    'utf8'
  )
  const match = /BRIDGE_FAULT_GRANT = '([a-zA-Z]+)'/.exec(source)
  if (!match) {
    throw new Error('could not read BRIDGE_FAULT_GRANT from bridge-frame-fields.ts')
  }
  return match[1]
}

export async function readBridgePagePainted() {
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-page-painted.ts'),
    'utf8'
  )
  const match = /BRIDGE_PAGE_PAINTED = '([a-zA-Z]+)'/.exec(source)
  if (!match) {
    throw new Error('could not read BRIDGE_PAGE_PAINTED from bridge-page-painted.ts')
  }
  return match[1]
}

// Read claim/back/pop names from source; observing pop distinguishes sheet close from whole-screen navigation.
export async function readBridgeBackNames() {
  const lane = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-page-back.ts'),
    'utf8'
  )
  const fields = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-frame-fields.ts'),
    'utf8'
  )
  const claim = /BRIDGE_BACK_CLAIM_NOTIFY = '([a-z-]+)'/.exec(lane)
  const frame = /BRIDGE_BACK_FRAME = '([a-z-]+)'/.exec(lane)
  const navigateBack = /BRIDGE_NAVIGATE_BACK_NOTIFY = '([a-z-]+)'/.exec(fields)
  if (!claim || !frame || !navigateBack) {
    throw new Error('could not read the Back names the page and the shell exchange')
  }
  return { claim: claim[1], frame: frame[1], navigateBack: navigateBack[1] }
}

// Reply ready/init to mount page; answer only caller-supplied RPC fixtures and refuse others so transport double decides no domain behavior.
// Keep whole notifies: shell handoff and inert action leave same document. Match binary canCarry/ack ledger to real host.
// Serialized init script must close over nothing and accept plain data.
export function installShellDouble({
  version,
  sessionId,
  buildId,
  route,
  host,
  storage,
  faultGrant,
  grants,
  pageRoutes = null,
  pageRouteGrants = null,
  backFrame = null,
  replies,
  streams = [],
  windowCaps = null,
  safeAreaInsets = null,
  ownsHostArea = false
}) {
  // Capture boundary faults so blank route reports own error instead of timing out.
  globalThis.__orcaRenderCheckFaults = []
  // Keep grant-gated notifies in order to distinguish shell handoff from no action.
  globalThis.__orcaRenderCheckNotifies = []
  // Keep full request verbs/geometry to assert gesture’s actual host effect.
  globalThis.__orcaRenderCheckRequests = []
  // Record wantsBinary on accepted subscriptions; absent request cannot be inferred from absent frames.
  globalThis.__orcaRenderCheckSubscribes = []
  // Count host-cap frame drops so page can prove stream survives rejected frame.
  globalThis.__orcaRenderCheckDroppedFrames = []
  // Record ack sequence: page paint alone cannot prove every frame acknowledged.
  globalThis.__orcaRenderCheckAcks = []
  const openStreams = new Map()
  // Shell owns Back delivery; expose explicit injection because document cannot generate this host frame.
  globalThis.__orcaRenderCheckSendBack = () => {
    if (backFrame === null) {
      throw new Error('this shell double was not given the back frame name')
    }
    channel.onmessage?.({ data: JSON.stringify({ v: version, type: backFrame }) })
  }
  // Allow second init to update live route/safe-area like shell.
  const initFrame = (patch = {}) => ({
    v: version,
    type: 'init',
    sessionId,
    buildId,
    connection: {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: 1,
      lastInboundAt: 1,
      generation: 0
    },
    grants: {
      rpc: { maxPendingRequests: 64, maxSubscriptions: 32 },
      // Default to fault-only grants; unnamed list must not be undefined.
      native: grants ?? [faultGrant]
    },
    ...(pageRoutes === null ? {} : { pageRoutes }),
    // Omit absent coverage for older-shell behavior; empty field has different semantics.
    ...(pageRouteGrants === null ? {} : { pageRouteGrants }),
    // Omit unnamed route for old-shell missing-route panel.
    ...(route === null ? {} : { route }),
    ...(host === null ? {} : { host }),
    storage,
    ...(safeAreaInsets === null ? {} : { safeAreaInsets }),
    // Host-area session ownership appears only on wide host route.
    ...(ownsHostArea ? { ownsHostArea: true } : {}),
    ...patch
  })
  globalThis.__orcaRenderCheckResendInit = (patch) => {
    channel.onmessage?.({ data: JSON.stringify(initFrame(patch)) })
  }
  const channel = {
    postMessage: (json) => {
      const frame = JSON.parse(json)
      const answer = (message) => {
        // Reply ready in microtask after entry script without moving timer used by page backoff.
        queueMicrotask(() => {
          channel.onmessage?.({ data: JSON.stringify(message) })
        })
      }
      if (frame.type === 'ready') {
        answer(initFrame())
        return
      }
      if (frame.type === 'notify') {
        globalThis.__orcaRenderCheckNotifies.push(frame)
        if (frame.name === faultGrant) {
          globalThis.__orcaRenderCheckFaults.push(frame.error.message)
        }
        return
      }
      // Only named caller fixtures answer; all other methods must follow refusal path.
      if (frame.type === 'subscribe' && streams.includes(frame.method)) {
        globalThis.__orcaRenderCheckSubscribes.push({
          id: frame.id,
          method: frame.method,
          params: frame.params,
          wantsBinary: frame.wantsBinary === true
        })
        // Subscription acceptance is silent like host; first reply is event until error/end closes stream.
        openStreams.set(frame.id, { seq: 0, unacked: [], unackedBytes: 0 })
        return
      }
      if (frame.type === 'ack') {
        // Consume ack exactly like host to reopen frame/byte window; ignored acks would falsely drop valid stream frames.
        const stream = openStreams.get(frame.id)
        if (stream) {
          let acked = 0
          for (const pending of stream.unacked) {
            if (pending.seq > frame.seq) {
              break
            }
            stream.unackedBytes -= pending.bytes
            acked += 1
          }
          stream.unacked.splice(0, acked)
          globalThis.__orcaRenderCheckAcks.push(frame.seq)
        }
        return
      }
      if (frame.type === 'cancel') {
        openStreams.delete(frame.id)
        return
      }
      if (frame.type === 'request') {
        globalThis.__orcaRenderCheckRequests.push({ method: frame.method, params: frame.params })
      }
      if (frame.type === 'request' && replies && Object.hasOwn(replies, frame.method)) {
        answer({
          v: version,
          type: 'reply',
          id: frame.id,
          payload: { id: frame.id, ok: true, result: replies[frame.method] }
        })
        return
      }
      if (frame.type === 'request' || frame.type === 'subscribe') {
        answer({
          v: version,
          type: 'error',
          id: frame.id,
          error: {
            category: 'RenderCheckShellDouble',
            message: 'the render check answers no RPC',
            isRpcDeliveryUnknown: false
          }
        })
      }
    },
    onmessage: null
  }
  // Match all host canCarry bounds: message cap, inflight frame count and inflight bytes; uncarriable frames drop without closing stream.
  // Long stream requires actual page acks to reopen same ledger, not artificial unlimited delivery.
  globalThis.__orcaRenderCheckEmitBinary = (id, binary) => {
    const stream = openStreams.get(id)
    if (!stream) {
      return 'no-stream'
    }
    const seq = stream.seq + 1
    const json = JSON.stringify({ v: version, type: 'event', id, seq, binary })
    const bytes = new TextEncoder().encode(json).length
    const carries =
      windowCaps === null ||
      (bytes <= windowCaps.maxMessageBytes &&
        stream.unacked.length < windowCaps.maxUnackedFrames &&
        stream.unackedBytes + bytes <= windowCaps.maxUnackedBytes)
    if (!carries) {
      globalThis.__orcaRenderCheckDroppedFrames.push(binary.frameSeq)
      return 'dropped'
    }
    stream.seq = seq
    stream.unacked.push({ seq, bytes })
    stream.unackedBytes += bytes
    channel.onmessage?.({ data: json })
    return 'posted'
  }
  // Session/terminal streams arrive as JSON: native client decodes terminal binary before bridge. Fixture events are below cap, so do not invent drop.
  // Still charge bytes to shared ledger: ack subtracts them, and uncharged JSON once made byte count negative/unbounded.
  globalThis.__orcaRenderCheckEmitEvent = (id, payload) => {
    const stream = openStreams.get(id)
    if (!stream) {
      return 'no-stream'
    }
    const seq = stream.seq + 1
    const json = JSON.stringify({ v: version, type: 'event', id, seq, payload })
    const bytes = new TextEncoder().encode(json).length
    stream.seq = seq
    stream.unacked.push({ seq, bytes })
    stream.unackedBytes += bytes
    channel.onmessage?.({ data: json })
    return 'posted'
  }
  globalThis.__orcaRenderCheckWindow = (id) => {
    const stream = openStreams.get(id)
    return stream === undefined
      ? null
      : { frames: stream.unacked.length, unackedBytes: stream.unackedBytes }
  }
  globalThis.orcaBridge = channel
}

const RECORDED_REQUEST_MS = 30_000

// Await effect-issued startup RPCs after chrome paint; snapshot at text commit races loaded CI. Bound reports missing and received verbs.
export async function waitForRecordedRequests(
  page,
  methods,
  { boundMs = RECORDED_REQUEST_MS } = {}
) {
  const started = Date.now()
  for (;;) {
    const requests = await page.evaluate(() => globalThis.__orcaRenderCheckRequests ?? [])
    const missing = methods.filter((method) => !requests.some((one) => one.method === method))
    if (missing.length === 0) {
      return requests
    }
    if (Date.now() - started > boundMs) {
      throw new Error(
        `[render-harness] the page never asked for ${missing.join(', ')} in ${String(boundMs)}ms; ` +
          `it asked for ${JSON.stringify(requests.map((one) => one.method))}`
      )
    }
    await page.waitForTimeout(25)
  }
}

// Serve real built bundle under shipped CSP; transformChunk poisons real route, per-request CSP/report handler supports preview arms.
export async function createBundleServer({
  outDir,
  cspHeader,
  documentHeaders,
  transformChunk,
  handleRequest
}) {
  const requestedPaths = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    // Log server requests including browser-process favicon fetch invisible to page.on(request).
    requestedPaths.push(path)
    // Answer custom report endpoint before filesystem lookup; CSP report-uri must resolve on actual page origin.
    if (handleRequest?.(request, response, path)) {
      return
    }
    // Return 204 favicon for probe documents: full runner Chrome auto-fetches it, bundled headless/WebView do not.
    // Product document carries data icon; session-render asserts request absence via server log, so response fallback hides no product regression.
    if (path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    // Serve entry for route paths only; missing file assets must 404 or catch-all hides bad publicPath.
    const namesAFile = path.slice(path.lastIndexOf('/')).includes('.')
    const file = namesAFile ? path.slice(1) : 'index.html'
    readFile(join(outDir, file)).then(
      (real) => {
        const bytes = transformChunk ? transformChunk(path, real) : real
        const headers = {
          'content-type': contentTypeForExtension(extname(file).slice(1))
        }
        // Attach shipped CSP to document only, matching native asset handler.
        if (file === 'index.html' && cspHeader) {
          // Per-document CSP function supplies nonce-specific report endpoint.
          headers['content-security-policy'] =
            typeof cspHeader === 'function' ? cspHeader(request) : cspHeader
        }
        if (file === 'index.html' && documentHeaders) {
          Object.assign(headers, documentHeaders)
        }
        response.writeHead(200, headers)
        response.end(bytes)
      },
      () => {
        response.writeHead(404)
        response.end()
      }
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${String(server.address().port)}`, requestedPaths }
}

// Install page-owned onerror sentinel before terminal; identity-check within page since function cannot survive evaluate serialization.
// Return false to preserve normal reporting; null-only checks miss terminal overwriting another consumer’s handler.
export function installPageErrorSentinel() {
  globalThis.__orcaSentinelCalls = []
  const sentinel = (message) => {
    globalThis.__orcaSentinelCalls.push(String(message))
    return false
  }
  globalThis.__orcaSentinel = sentinel
  window.onerror = sentinel
}

// Tag scheduled work with current terminal container; firing after that element leaves DOM proves callback leaked into replacement.
// Use actual DOM lifetime, not test mount counter (React schedules independently); retain all schedules to prove work existed before asserting none leaked.
export function installSchedulerRecorder() {
  globalThis.__orcaScheduler = { watching: false, scheduled: [], leaked: [], heldFrames: 0 }
  const state = globalThis.__orcaScheduler
  const requestFrame = globalThis.requestAnimationFrame.bind(globalThis)
  const cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis)
  const heldFrames = new Map()
  let nextHeldFrame = -2
  globalThis.__orcaReleaseFrames = () => {
    state.holdFramesFrom = null
    for (const callback of heldFrames.values()) {
      requestFrame(callback)
    }
    heldFrames.clear()
    state.heldFrames = 0
  }
  globalThis.cancelAnimationFrame = (id) => {
    if (heldFrames.delete(id)) {
      state.heldFrames--
    } else {
      cancelFrame(id)
    }
  }
  const wrap = (schedule, kind) =>
    function (callback, ...rest) {
      if (!state.watching || typeof callback !== 'function') {
        return schedule(callback, ...rest)
      }
      const caller = ((new Error('scheduled').stack ?? '').split('\n')[2] ?? '').trim()
      const container = document.getElementById('terminal-container')
      // Track fired separately: cancelled and pending callbacks can both remain unfired.
      const entry = { kind, caller, owned: container !== null, fired: false }
      state.scheduled.push(entry)
      const recorded = (...args) => {
        entry.fired = true
        if (container !== null && !container.isConnected) {
          state.leaked.push(`${kind} from ${caller}`)
        }
        return callback(...args)
      }
      if (kind === 'frame' && state.holdFramesFrom && caller.includes(state.holdFramesFrom)) {
        const id = nextHeldFrame--
        heldFrames.set(id, recorded)
        state.heldFrames++
        return id
      }
      return schedule(recorded, ...rest)
    }
  globalThis.requestAnimationFrame = wrap(requestFrame, 'frame')
  globalThis.setTimeout = wrap(globalThis.setTimeout.bind(globalThis), 'timer')
  globalThis.setInterval = wrap(globalThis.setInterval.bind(globalThis), 'interval')
}

// Install before bundle so boot-time refusal counts too.
// Track listener identity/target/type/phase, not add/remove call totals: DOM duplicate adds and absent removes are no-ops.
export function installListenerRecorder({ selector } = {}) {
  const elements = new WeakMap()
  let nextElement = 0
  const live = new Map()
  globalThis.__orcaListeners = {
    snapshot: () =>
      Object.fromEntries(
        [...live.entries()]
          .map(([key, listeners]) => [key, listeners.size])
          .filter(([, n]) => n > 0)
      )
  }
  const keyFor = (target, type, options) => {
    let where = target === globalThis ? 'window' : target === document ? 'document' : null
    if (where === null && selector && target instanceof Element && target.matches(selector)) {
      if (!elements.has(target)) {
        elements.set(target, ++nextElement)
      }
      where = `element ${elements.get(target)}`
    }
    if (where === null) {
      return null
    }
    const capture = typeof options === 'object' && options !== null ? !!options.capture : !!options
    return `${where} ${type}${capture ? ' capture' : ''}`
  }
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const key = keyFor(this, type, options)
    if (key !== null && listener) {
      if (!live.has(key)) {
        live.set(key, new Set())
      }
      live.get(key).add(listener)
    }
    return add.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const key = keyFor(this, type, options)
    if (key !== null && listener) {
      live.get(key)?.delete(listener)
    }
    return remove.call(this, type, listener, options)
  }
}

export function installCspViolationRecorder() {
  globalThis.__orcaCspViolations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    globalThis.__orcaCspViolations.push(
      `${event.violatedDirective}: ${event.blockedURI || 'inline'} @ ${event.sourceFile ?? '?'}:${String(event.lineNumber ?? 0)}`
    )
  })
}

// Compare every html/body computed property against same app without terminal; handpicked style list could miss escaped rule.
export async function readRootComputedStyles(page) {
  return await page.evaluate(() => {
    const read = (element) => {
      const computed = getComputedStyle(element)
      const entries = []
      for (const property of computed) {
        entries.push(`${property}: ${computed.getPropertyValue(property)}`)
      }
      return entries.join('\n')
    }
    return { body: read(document.body), html: read(document.documentElement) }
  })
}

// Require injected rule count before interpreting no escaped matches; missing/refused sheet also matches nothing.
export async function terminalStyleReach(page) {
  return await page.evaluate(() => {
    const sheet = [...document.styleSheets].find(
      (one) => one.ownerNode?.id === 'orca-terminal-document-style'
    )
    if (!sheet) {
      return { rules: 0, outside: ['the terminal stylesheet is not in the head'] }
    }
    const host = document.querySelector('.orca-terminal-document-host')
    const outside = []
    for (const rule of sheet.cssRules) {
      for (const element of document.querySelectorAll(rule.selectorText)) {
        if (!host || !host.contains(element)) {
          outside.push(`${rule.selectorText} matched ${element.tagName}`)
        }
      }
    }
    return { rules: sheet.cssRules.length, outside }
  })
}

export async function waitForPageFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
  )
}
