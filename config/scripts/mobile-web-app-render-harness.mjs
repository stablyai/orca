import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectDir = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Both CSP constants are a list of quoted directives with `//` comments between them, and those
 * comments quote directive text. Dropping comment lines first is what keeps a comment out of the
 * header a test serves.
 */
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

/**
 * The shipped policy, read from the Kotlin source so a test cannot drift from what the shell
 * actually sends. Parsed rather than imported: the constant lives in a JVM module.
 */
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

/**
 * The envelope version the page speaks, read from the contract rather than written down twice. A
 * bumped `v` would otherwise reach a test as a 30s timeout naming nothing.
 */
export async function readBridgeProtocolVersion() {
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-envelope.ts'),
    'utf8'
  )
  const match = /BRIDGE_PROTOCOL_VERSION = (\d+)/.exec(source)
  if (!match) {
    throw new Error('could not read BRIDGE_PROTOCOL_VERSION')
  }
  return Number(match[1])
}

/**
 * The bridge's window caps, read from the modules that define them.
 *
 * The shell double below has to price a frame the way `BridgeHostSubscriptions` does, and a double
 * carrying its own copy of these numbers is a double that goes on passing after the real host's
 * changed. `BRIDGE_MAX_UNACKED_BYTES` is written as a product, so the reader evaluates one.
 */
export async function readBridgeWindowCaps() {
  const sources = await Promise.all(
    [
      'mobile/src/mobile-web-shell/bridge/bridge-caps.ts',
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
    maxMessageBytes: read('BRIDGE_MAX_MESSAGE_BYTES'),
    maxUnackedFrames: read('BRIDGE_MAX_UNACKED_FRAMES'),
    maxUnackedBytes: read('BRIDGE_MAX_UNACKED_BYTES')
  }
}

/**
 * The base64 one append of the clipboard-image upload carries, read from the leaf that defines it.
 *
 * The page's canvas resize is measured against this, so a check carrying its own copy is one that
 * goes on passing after the upload path's chunk has moved. Written as a product, so the reader
 * evaluates one the way the window caps above do.
 */
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

/**
 * The JPEG quality the pane asks Chromium for, read from the module that sends it. A test that
 * encoded its fixtures at a retyped quality would certify the budget at a number nothing ships.
 */
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

/** The grant the shell offers every page, read from the same source for the same reason. */
export async function readBridgeFaultGrant() {
  const source = await readFile(
    join(projectDir, 'mobile/src/mobile-web-shell/bridge/bridge-envelope.ts'),
    'utf8'
  )
  const match = /BRIDGE_FAULT_GRANT = '([a-zA-Z]+)'/.exec(source)
  if (!match) {
    throw new Error('could not read BRIDGE_FAULT_GRANT')
  }
  return match[1]
}

/**
 * The shell's half of the bridge, as the page's channel sees it.
 *
 * The entry mounts nothing until `init` lands, so a render check with no shell renders no route at
 * all. This answers `ready`, answers the methods `replies` names, and refuses everything else: a
 * real reply would make this file the place domain behaviour is decided, and every screen below
 * already has a state for an RPC that failed. `grants` and `pageRoutes` are what the shell would
 * have negotiated, and every notify the page posts is kept whole in `__orcaRenderCheckNotifies`,
 * because a control that handed something to the shell and one that did nothing look the same on
 * the document.
 *
 * It answers RPC the way a refusing host does and serves a screencast stream the way the real
 * `BridgeHostSubscriptions` does, including its whole `canCarry` rule and the page's acks. It is
 * not the host: it decides no domain behaviour, and every reply a screen sees is one a check
 * named.
 *
 * Serialized as a page init script, so it takes plain data and closes over nothing.
 */
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
  replies,
  streams = [],
  windowCaps = null
}) {
  // Where the page's own fault reports land. Read back after the render, so a route that threw
  // under the boundary names itself instead of timing out as a page that never mounted.
  globalThis.__orcaRenderCheckFaults = []
  // Every grant-gated notify the page posted, whole and in order. A control that decided to hand
  // something to the shell and a control that did nothing look identical on the document; this is
  // the only thing that tells them apart.
  globalThis.__orcaRenderCheckNotifies = []
  // Every request the page issued, whole and in order, so a check can say which verb a gesture
  // produced and with what geometry rather than only that something was sent.
  globalThis.__orcaRenderCheckRequests = []
  // The subscriptions the double accepted, with the `wantsBinary` each one asked for: the negative
  // case is "the page did not ask", which no assertion on the frames can see.
  globalThis.__orcaRenderCheckSubscribes = []
  // Binary events this double refused to post because they exceeded the frame cap, which is the
  // shell's drop rule reproduced where the page can watch it survive one.
  globalThis.__orcaRenderCheckDroppedFrames = []
  // Every ack seq the page posted, in order. Without this a stream that never acked and one that
  // acked every frame look the same from the page's side.
  globalThis.__orcaRenderCheckAcks = []
  const openStreams = new Map()
  const channel = {
    postMessage: (json) => {
      const frame = JSON.parse(json)
      const answer = (message) => {
        // A microtask, not a task: the page posts `ready` while its script is still running, and
        // this keeps the answer behind it without moving a timer the page's backoff reads.
        queueMicrotask(() => {
          channel.onmessage?.({ data: JSON.stringify(message) })
        })
      }
      if (frame.type === 'ready') {
        answer({
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
            // The fault grant alone unless the caller named a set: every check needs that one,
            // and a check that names none must not be handed an undefined list.
            native: grants ?? [faultGrant]
          },
          ...(pageRoutes === null ? {} : { pageRoutes }),
          // Omitted for a shell too old to name one, which is the case the page has a panel for.
          ...(route === null ? {} : { route }),
          ...(host === null ? {} : { host }),
          storage
        })
        return
      }
      if (frame.type === 'notify') {
        globalThis.__orcaRenderCheckNotifies.push(frame)
        if (frame.name === faultGrant) {
          globalThis.__orcaRenderCheckFaults.push(frame.error.message)
        }
        return
      }
      // The result the caller named for this method, carried in the envelope a real host uses.
      // Anything unnamed still takes the refusal below, so a screen only ever sees data a test
      // asked for.
      if (frame.type === 'subscribe' && streams.includes(frame.method)) {
        globalThis.__orcaRenderCheckSubscribes.push({
          id: frame.id,
          method: frame.method,
          params: frame.params,
          wantsBinary: frame.wantsBinary === true
        })
        // Accepted by saying nothing, exactly as the real host does: a subscription is open until
        // an `error` or an `end` closes it, and the first thing the page hears is an event.
        openStreams.set(frame.id, { seq: 0, unacked: [], unackedBytes: 0 })
        return
      }
      if (frame.type === 'ack') {
        // The page's ack is what reopens the window, so a double that ignored it would drop
        // frames the real host carries. Read exactly as `BridgeHostSubscriptions.ack` reads it.
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
  /**
   * One screencast frame from the shell, priced the way `BridgeHostSubscriptions` prices it.
   *
   * All three arms of the host's `canCarry`, not just the size one: a frame over the message cap,
   * a window already holding the most frames it may, and a window whose bytes this frame would
   * push past the limit. Dropping is the behaviour under test — the event goes nowhere, the
   * stream stays open, and the next frame paints — so a double that posted an uncarriable frame
   * would prove the page decodes something no shell could have sent.
   *
   * The window only stays open because the page acks, which the `ack` arm above consumes. That is
   * what makes a long stream a real test of both rather than of neither.
   */
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
  globalThis.orcaBridge = channel
}

/**
 * The page server the render checks run against: the built bundle, under the shell's own policy.
 *
 * `transformChunk` is how a check poisons one route chunk without building a second bundle.
 */
export async function createBundleServer({ outDir, cspHeader, transformChunk }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    // A browser asks for this on its own and the shell's WebView never does. The bundle carries
    // no icon, so a 404 would put a console error in every check that runs against a full Chrome
    // -- which is what CI resolves -- and none against the bundled headless shell.
    if (path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    // A route path serves the entrypoint and the page routes client-side. A path naming a file
    // has to come out of the bundle or 404, the same as the shell's manifest map: answering it
    // with the document instead would hide a publicPath the script cannot fetch from.
    const namesAFile = path.slice(path.lastIndexOf('/')).includes('.')
    const file = namesAFile ? path.slice(1) : 'index.html'
    readFile(join(outDir, file)).then(
      (real) => {
        const bytes = transformChunk ? transformChunk(path, real) : real
        const headers = {
          'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html'
        }
        // The document carries the shell's real policy, so a directive the page violates fails
        // here rather than on a phone. Assets carry none, exactly as the native handler does.
        if (file === 'index.html' && cspHeader) {
          headers['content-security-policy'] = cspHeader
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
  return { server, origin: `http://127.0.0.1:${String(server.address().port)}` }
}

/**
 * A handler of the page's own, installed before the bundle so the terminal meets a `window.onerror`
 * that belongs to someone else.
 *
 * Reading `null` three times would pass on a terminal that assigned `null` over a real handler,
 * which is the failure this seam exists to prevent. The sentinel is identity-checked in the page
 * rather than marshalled out of it — a function does not survive `evaluate` — and it returns
 * false so the browser still reports the error normally.
 */
export function installPageErrorSentinel() {
  globalThis.__orcaSentinelCalls = []
  const sentinel = (message) => {
    globalThis.__orcaSentinelCalls.push(String(message))
    return false
  }
  globalThis.__orcaSentinel = sentinel
  window.onerror = sentinel
}

/**
 * Every animation frame and timer, tagged with the mount that scheduled it.
 *
 * Installed before the bundle loads, so the document's own scheduling goes through it. Each
 * schedule remembers the `#terminal-container` that was on the page at the time; a callback that
 * runs once that element has left the document is a frame or timer of the first mount firing
 * into the second, which is the whole finding. The element rather than a counter the test bumps,
 * because React unmounts on its own schedule and a callback that runs while the first terminal is
 * still up is not a leak. Every schedule is kept, not just the ones still owed, so the test can
 * say that there was something to leak before it says that nothing did.
 */
export function installSchedulerRecorder() {
  globalThis.__orcaScheduler = { watching: false, scheduled: [], leaked: [] }
  const state = globalThis.__orcaScheduler
  const wrap = (schedule, kind) =>
    function (callback, ...rest) {
      if (!state.watching || typeof callback !== 'function') {
        return schedule(callback, ...rest)
      }
      // The line that called this, which is the script the work belongs to. Line 0 is the error's
      // own header and line 1 is this wrapper.
      const caller = ((new Error('scheduled').stack ?? '').split('\n')[2] ?? '').trim()
      const container = document.getElementById('terminal-container')
      // `fired` is what makes "owed" readable: a callback that has not run is still owed, whether
      // it was cancelled or is merely waiting, and cancelling never sets it.
      const entry = { kind, caller, owned: container !== null, fired: false }
      state.scheduled.push(entry)
      return schedule(
        (...args) => {
          entry.fired = true
          if (container !== null && !container.isConnected) {
            state.leaked.push(`${kind} from ${caller}`)
          }
          return callback(...args)
        },
        ...rest
      )
    }
  globalThis.requestAnimationFrame = wrap(
    globalThis.requestAnimationFrame.bind(globalThis),
    'frame'
  )
  globalThis.setTimeout = wrap(globalThis.setTimeout.bind(globalThis), 'timer')
  globalThis.setInterval = wrap(globalThis.setInterval.bind(globalThis), 'interval')
}

/** Recorded before anything else runs, so a refusal during the page's own boot is counted. */
/**
 * Every window and document listener the page holds, by target, type and phase.
 *
 * Identity, not a tally: `addEventListener` with a listener the target already holds is a no-op in
 * the DOM, and `removeEventListener` with one it does not hold is too, so counting calls would
 * report leaks a browser does not have. The set is the live listeners, which is what a snapshot
 * before and after a mount can be compared on.
 */
export function installListenerRecorder() {
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
    const where = target === globalThis ? 'window' : target === document ? 'document' : null
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

/**
 * Every computed property of `html` and `body`, as one string each.
 *
 * The oracle for "the page mount styles only what it owns" is a page of the same application with
 * no terminal on it, so the comparison is against another page rather than against a list of
 * properties someone chose. A rule that escaped the host would have to move one of these.
 */
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

/**
 * What the terminal's injected sheet matches, and how much of it there is.
 *
 * The rule count is the precondition for the empty list: a sheet that was never planted, or one
 * the browser refused, would match nothing for a reason that has nothing to do with scoping.
 */
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
