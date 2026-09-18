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
  const body = source.slice(source.indexOf('listOf('), source.indexOf(').joinToString'))
  const directives = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (directives.length < 10) {
    throw new Error('could not parse MOBILE_WEB_SHELL_CSP')
  }
  return directives.join('; ')
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

async function render(route) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  const warnings = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    } else if (message.type() === 'warning') {
      warnings.push(message.text())
    }
  })
  await page.goto(`${origin}${route}`, { waitUntil: 'load' })
  await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, {
    timeout: 30_000
  })
  const text = await page.evaluate(() => document.body.innerText)
  const html = await page.evaluate(() => document.getElementById('root').innerHTML)
  await page.close()
  return { errors, warnings, text, html }
}

describe('the shell policy this page is tested under', () => {
  it('is the same on both platforms, so one render check covers both', async () => {
    const swift = await readFile(
      join(projectDir, 'mobile/modules/orca-mobile-web-shell/ios/MobileWebShellCsp.swift'),
      'utf8'
    )
    const body = swift.slice(swift.indexOf('static let header = ['), swift.indexOf('].joined'))
    const ios = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).join('; ')
    expect(ios).toBe(cspHeader)
  })

  it('still refuses inline script, which is the directive that matters', () => {
    expect(cspHeader).toContain("script-src 'self';")
    expect(cspHeader).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})

describe('the Route A page in a real browser', () => {
  it('mounts the worktree list route with no page or console errors', async () => {
    const { errors, html, text } = await render(HOST_ROUTE)
    expect(errors).toEqual([])
    expect(html.length).toBeGreaterThan(100)
    // The placeholder client knows no host, so the list renders its not-found state rather than
    // rows. That it rendered at all is the claim: ExpoRoot matched /h/:hostId and mounted.
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  it('routes a nested dynamic segment through the same context', async () => {
    const { errors, html } = await render(`${HOST_ROUTE}/tasks`)
    expect(errors).toEqual([])
    expect(html.length).toBeGreaterThan(100)
  }, 60_000)

  it('renders the unmatched route rather than crashing on a path with no module', async () => {
    const { errors, html } = await render('/h/render-check-host/not-a-route')
    expect(errors).toEqual([])
    expect(html.length).toBeGreaterThan(0)
  }, 60_000)
})
