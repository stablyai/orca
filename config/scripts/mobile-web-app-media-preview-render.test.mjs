import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

// Two gray VP9 frames generated with ffmpeg, without audio or user content.
const WEBM =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH6EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHk7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAn0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIPYwl7RGcI1acgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgSC6gSCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNz2mPAi2PFiD2MJe0RnCNWZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnW354EAo52BAACAgkmDQgAB8AH2ADgkHBhKAAAwYAAAItXAAKOTgQPoAIYAQJKcAFAAAANgAABDQBxTu2uRu4+zgQC3iveBAfGCAajwgQM='
function wavFixture() {
  const bytes = Buffer.alloc(44 + 8000 * 2 * 2)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}
const host = { id: 'media-host', name: 'Media Host', endpoint: 'ws://media-test', lastConnected: 1 }
const pattern = '/h/[hostId]/files/preview/[worktreeId]'
const pathname = '/h/media-host/files/preview/folder-project'
const bundles = mobileWebAppDependenciesPresent()
let scratch, server, origin, browser, policy, version, faultGrant
beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-media-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  policy = await readShellCsp()
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  const served = await createBundleServer({
    outDir: built.outDir,
    cspHeader: (request) =>
      request.url.includes('oldShell=1')
        ? policy.replace('media-src blob:', "media-src 'none'")
        : policy
  })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 120_000)
afterAll(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})
async function openMedia(relativePath, bytes, oldShell = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const grants = MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === pattern).grants
  await page.addInitScript(installShellDouble, {
    version,
    sessionId: 'media-session',
    buildId: 'media-build',
    route: {
      pathname,
      params: { relativePath, name: relativePath, worktreeName: 'Folder project' }
    },
    host,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...grants],
    pageRoutes: [pattern],
    replies: {
      'files.stat': { size: bytes.length, isDirectory: false, mtime: 1 },
      'files.readChunk': {
        contentBase64: bytes.toString('base64'),
        bytesRead: bytes.length,
        eof: true
      },
      'files.read': {
        content: 'Playback stopped after switching files',
        byteLength: 43,
        truncated: false
      }
    }
  })
  await page.addInitScript(() => {
    globalThis.__revokedMedia = []
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (uri) => {
      globalThis.__revokedMedia.push(uri)
      revoke(uri)
    }
  })
  await page.goto(`${origin}/?${oldShell ? 'oldShell=1' : ''}`)
  return { page, errors }
}
const describeRender = bundles ? describe : describe.skip
describeRender('mobile media under the shipped shell policy', () => {
  it.each([
    ['music.wav', wavFixture(), 'audio'],
    ['movie.webm', Buffer.from(WEBM, 'base64'), 'video']
  ])(
    'plays and seeks %s, then releases playback and its Blob on navigation',
    async (name, bytes, tag) => {
      const { page, errors } = await openMedia(name, bytes)
      await page.waitForFunction((tag) => document.querySelector(tag)?.readyState >= 2, tag)
      const playback = await page.evaluate(async (tag) => {
        const media = document.querySelector(tag)
        globalThis.__previousMedia = media
        media.muted = true
        media.currentTime = 1
        await media.play()
        await new Promise((resolve) => setTimeout(resolve, 200))
        media.pause()
        return {
          duration: media.duration,
          time: media.currentTime,
          controls: media.controls,
          autoplay: media.autoplay,
          uri: media.currentSrc
        }
      }, tag)
      expect(playback.duration).toBeCloseTo(2, 1)
      expect(playback.time).toBeGreaterThan(1)
      expect(playback.controls).toBe(true)
      expect(playback.autoplay).toBe(false)
      await page.evaluate((pathname) => {
        history.pushState(null, '', `${pathname}?relativePath=README.md`)
        dispatchEvent(new PopStateEvent('popstate'))
      }, pathname)
      await page.getByText('Playback stopped after switching files', { exact: true }).waitFor()
      expect(
        await page.evaluate(() => ({
          paused: globalThis.__previousMedia.paused,
          src: globalThis.__previousMedia.getAttribute('src'),
          revoked: globalThis.__revokedMedia
        }))
      ).toEqual({ paused: true, src: null, revoked: [playback.uri] })
      expect(errors).toEqual([])
      await page.close()
    },
    60_000
  )
  it('explains the required app update when an older shell blocks Blob playback', async () => {
    const { page } = await openMedia('music.wav', wavFixture(), true)
    await page
      .getByText('Update Orca Mobile to play media in this workspace', { exact: true })
      .waitFor()
    await page.close()
  }, 60_000)
})
