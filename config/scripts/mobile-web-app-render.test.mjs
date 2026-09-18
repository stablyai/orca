import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))

// Why a real browser: the route tree is handed to expo-router's own ExpoRoot through a synthesized
// RequireContext. Nothing short of mounting it proves that object is the shape ExpoRoot reads.
const HOST_ROUTE = '/h/render-check-host'

let scratch
let server
let browser
let origin
let cspHeader = null

/**
 * Both CSP constants are a list of quoted directives with `//` comments between them, and those
 * comments quote directive text. Dropping comment lines first is what keeps a comment out of the
 * header this test serves.
 */
export function parseCspDirectives(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start < 0 || end < start) {
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
 * The shipped policy, read from the Kotlin source so this test cannot drift from what the shell
 * actually sends. Parsed rather than imported: the constant lives in a JVM module.
 */
async function readShellCsp() {
  const source = await readFile(
    join(
      projectDir,
      'mobile/modules/orca-mobile-web-shell/android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellCsp.kt'
    ),
    'utf8'
  )
  return parseCspDirectives(source, 'listOf(', ').joinToString')
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-render-'))
  cspHeader = await readShellCsp()
  const { outDir } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    // Any route path serves the entrypoint; the page reads location and routes client-side.
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html'
    readFile(join(outDir, file)).then(
      (bytes) => {
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
  origin = `http://127.0.0.1:${String(server.address().port)}`
  // CI runs this against the runner's Google Chrome rather than paying for a browser download,
  // the same reason and the same override shape as the orcad browser-provider job.
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  await rm(scratch, { recursive: true, force: true })
})

// expo-router's Unmatched screen mounts cleanly and paints text, so "no errors, some html" stays
// green with every host route unreachable. Each route below names content only it can produce.
const UNMATCHED = 'Unmatched Route'

async function render(route) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  await page.goto(`${origin}${route}`, { waitUntil: 'load' })
  await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, {
    timeout: 30_000
  })
  const text = await page.evaluate(() => document.body.innerText)
  await page.close()
  // A CSP refusal reaches the page as a console error, so the caller's empty-errors assertion is
  // also the policy assertion; name it here so a failure says which one broke.
  return {
    errors,
    cspErrors: errors.filter((entry) => entry.includes('Content Security Policy')),
    text
  }
}

describe('the shell policy this page is tested under', () => {
  it('is the same on both platforms, so one render check covers both', async () => {
    const swift = await readFile(
      join(projectDir, 'mobile/modules/orca-mobile-web-shell/ios/MobileWebShellCsp.swift'),
      'utf8'
    )
    expect(parseCspDirectives(swift, 'static let header = [', '].joined')).toBe(cspHeader)
  })

  it('reads directives from the source and not from the comments around them', () => {
    const source = [
      'static let header = [',
      "  // React Native Web needs \"style-src 'self' 'unsafe-inline'\" and nothing more.",
      '  "default-src \'none\'",',
      '  "script-src \'self\'",',
      "  \"style-src 'self' 'unsafe-inline'\",",
      '  "img-src \'self\'",',
      '  "connect-src \'self\'",',
      '  "worker-src \'none\'",',
      '  "frame-src \'none\'",',
      '  "child-src \'none\'",',
      '  "object-src \'none\'",',
      '  "base-uri \'none\'",',
      '  "form-action \'none\'",',
      '  "frame-ancestors \'none\'"',
      '].joined'
    ].join('\n')
    const parsed = parseCspDirectives(source, 'static let header = [', '].joined')
    expect(parsed.split('; ')[0]).toBe("default-src 'none'")
    expect(parsed.split('; ').filter((entry) => entry.includes('unsafe-inline'))).toEqual([
      "style-src 'self' 'unsafe-inline'"
    ])
  })

  it('still refuses inline script, which is the directive that matters', () => {
    expect(cspHeader).toContain("script-src 'self';")
    expect(cspHeader).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})

describe('the Route A page in a real browser', () => {
  it('mounts the worktree list route, not the unmatched screen', async () => {
    const { errors, cspErrors, text } = await render(HOST_ROUTE)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    // app/h/[hostId]/index.tsx: the placeholder client knows no host, so the list paints its
    // not-found state. Only that route's own component produces this string.
    expect(text).toContain('Host not found')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('routes a nested dynamic segment through the same context', async () => {
    const { errors, cspErrors, text } = await render(`${HOST_ROUTE}/tasks`)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    // app/h/[hostId]/tasks.tsx paints its header and its GitHub filter row.
    expect(text).toContain('Tasks')
    expect(text).toContain('Issues')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('renders the unmatched route rather than crashing on a path with no module', async () => {
    const { errors, cspErrors, text } = await render(`${HOST_ROUTE}/not-a-route`)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    // Asserted positively so the two negatives above are known to discriminate.
    expect(text).toContain(UNMATCHED)
  }, 60_000)
})
