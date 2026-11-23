import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { contentTypeForExtension } from '../../build/mobile-web-app/mobile-web-bundle-manifest.mjs'
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
