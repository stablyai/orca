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
  replies
}) {
  // Where the page's own fault reports land. Read back after the render, so a route that threw
  // under the boundary names itself instead of timing out as a page that never mounted.
  globalThis.__orcaRenderCheckFaults = []
  // Every grant-gated notify the page posted, whole and in order. A control that decided to hand
  // something to the shell and a control that did nothing look identical on the document; this is
  // the only thing that tells them apart.
  globalThis.__orcaRenderCheckNotifies = []
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
