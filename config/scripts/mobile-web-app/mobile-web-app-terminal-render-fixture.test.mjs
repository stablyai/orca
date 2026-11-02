import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { startTerminalRenderFixture } from './mobile-web-app-terminal-render-fixture.mjs'

// Force missing-browser launch after server/scratch allocation; setup failure returns no cleanup handle and must release them itself or Vitest hangs.

const SCRATCH_PREFIX = 'orca-c75-terminal-render-'
const describeFixture = mobileWebAppDependenciesPresent() ? describe : describe.skip

let temporaryRoot = null
let realTemporaryRoot = null

beforeAll(async () => {
  // Use worker-private TMPDIR so sibling fixture creation/removal cannot pollute exact leftover-tree count.
  temporaryRoot = await mkdtemp(join(tmpdir(), 'orca-c75-fixture-rollback-'))
  realTemporaryRoot = process.env.TMPDIR
  process.env.TMPDIR = temporaryRoot
})

afterAll(async () => {
  if (realTemporaryRoot === undefined) {
    delete process.env.TMPDIR
  } else {
    process.env.TMPDIR = realTemporaryRoot
  }
  await rm(temporaryRoot, { recursive: true, force: true })
})

// Read Node’s exact server-handle name (TCPSERVERWRAP matches nothing); wait a tick after close callback for handle removal.
async function settledListeningSockets() {
  await new Promise((resolve) => setTimeout(resolve, 50))
  return process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length
}

describeFixture('the terminal render fixture', () => {
  it('takes back the server and the scratch tree when the browser will not start', async () => {
    const socketsBefore = await settledListeningSockets()
    const realBrowser = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
    process.env.ORCA_MOBILE_WEB_RENDER_BROWSER = join(temporaryRoot, 'orca-c75-no-such-browser')
    try {
      // Require exact launch error: unrelated earlier build failure would allocate no resources and pass cleanup assertions vacuously.
      await expect(startTerminalRenderFixture()).rejects.toThrow(
        /Failed to launch chromium because executable doesn't exist/
      )
    } finally {
      if (realBrowser === undefined) {
        delete process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      } else {
        process.env.ORCA_MOBILE_WEB_RENDER_BROWSER = realBrowser
      }
    }

    expect(await settledListeningSockets()).toBe(socketsBefore)
    // Check only fixture-owned tree prefix; Playwright profile/artifacts belong to Playwright cleanup.
    const left = (await readdir(temporaryRoot)).filter((entry) => entry.startsWith(SCRATCH_PREFIX))
    expect(left).toEqual([])
  }, 600_000)
})
