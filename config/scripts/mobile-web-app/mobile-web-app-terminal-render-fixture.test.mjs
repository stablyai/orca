import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { startTerminalRenderFixture } from './mobile-web-app-terminal-render-fixture.mjs'

/**
 * What the render fixture gives back when it never finishes starting.
 *
 * The handle is the only way to close it, so a setup that throws before returning one leaves the
 * caller nothing to call: `afterAll` has no fixture, and the listening socket and the scratch tree
 * stay where they are. The socket is the part that bites — an open server handle keeps the vitest
 * worker alive after its last test has reported, so the file hangs rather than failing.
 *
 * The browser is the step that fails in practice and the last one taken, so by then everything
 * else is allocated. It is made to fail the way it actually does, by pointing the launch at an
 * executable that is not there, rather than by standing a double in front of Playwright.
 */

/** The name the fixture gives its scratch tree, which is the only thing in here it owns. */
const SCRATCH_PREFIX = 'orca-c75-terminal-render-'
const describeFixture = mobileWebAppDependenciesPresent() ? describe : describe.skip

let temporaryRoot = null
let realTemporaryRoot = null

beforeAll(async () => {
  // The fixture names its scratch tree after `os.tmpdir()`, and the render check next door names
  // its own the same way in a worker of its own — so reading the shared temp directory reports
  // that one appearing and being swept up mid-case, which is not this case's business. Pointing
  // `TMPDIR` at a directory of this worker's own makes the reading exact: whatever is left in
  // here afterwards was left by the setup under test.
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

/**
 * Listening sockets this process holds, which is the handle that keeps a worker alive.
 *
 * Spelled as Node spells it: filtering on `TCPSERVERWRAP` matches nothing and reads zero in both
 * arms, which agrees with everything. And the handle is still listed while the close callback
 * runs, so the reading is taken a tick later, once the loop has let it go.
 */
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
      // Named, not merely thrown, and this is also the precondition the two readings below need.
      // A bare `toThrow` passes for a build that broke for its own reason, which would leave
      // nothing serving and nothing on disk and agree with both assertions for the wrong reason.
      // Reaching the launch at all means `createBundleServer` returned, because it is the
      // statement before it.
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
    // The fixture's own trees, by the name it gives them. The launch that failed leaves Playwright
    // artifacts and a browser profile in here too, and those are Playwright's to clean, not the
    // rollback's.
    const left = (await readdir(temporaryRoot)).filter((entry) => entry.startsWith(SCRATCH_PREFIX))
    expect(left).toEqual([])
  }, 600_000)
})
