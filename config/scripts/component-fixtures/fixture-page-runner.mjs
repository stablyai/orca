import { fixtureScreenshotPath } from './fixture-paths.mjs'

const FIXTURE_TIMEOUT_MS = 60_000

// Reuse a page per device scale, reloading after source changes so shots reflect disk.
export function createFixturePageRunner(baseUrl, browserPromise) {
  const workers = new Map()
  let sourceRevision = 0
  let cachedList = null
  let queue = Promise.resolve()

  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  async function createWorker(scale) {
    const browser = await browserPromise
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: scale
    })
    const page = await context.newPage()
    const worker = { page, revision: -1, pageErrors: [] }
    page.on('pageerror', (error) => worker.pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        worker.pageErrors.push(message.text())
      }
    })
    return worker
  }

  async function readyWorker(scale) {
    if (!workers.has(scale)) {
      workers.set(scale, createWorker(scale))
    }
    const worker = await workers.get(scale)
    if (worker.revision !== sourceRevision) {
      const revision = sourceRevision
      await worker.page.goto(`${baseUrl}/fixtures.html?worker=1`)
      await worker.page.waitForFunction(
        () => Boolean(window.__orcaComponentFixtureHost),
        undefined,
        { timeout: FIXTURE_TIMEOUT_MS }
      )
      worker.revision = revision
    }
    worker.pageErrors = []
    return worker
  }

  async function waitForFixtureOutcome(page) {
    await page.waitForFunction(
      () => ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? ''),
      undefined,
      { timeout: FIXTURE_TIMEOUT_MS }
    )
    return page.evaluate(() =>
      document.documentElement.dataset.fixtureState === 'error'
        ? (document.documentElement.dataset.fixtureError ?? 'Fixture failed.')
        : null
    )
  }

  function listFixtures() {
    return serialize(async () => {
      if (cachedList?.revision !== sourceRevision) {
        const revision = sourceRevision
        const { page } = await readyWorker(1)
        const fixtures = await page.evaluate(() => window.__orcaComponentFixtureHost.list())
        cachedList = { revision, fixtures }
      }
      return cachedList.fixtures
    })
  }

  async function renderInWorker(id, theme, scale) {
    const worker = await readyWorker(scale)
    await worker.page.evaluate(
      ([fixtureId, fixtureTheme]) =>
        window.__orcaComponentFixtureHost.render(fixtureId, fixtureTheme),
      [id, theme]
    )
    return { worker, failure: await waitForFixtureOutcome(worker.page) }
  }

  function screenshotFixture(id, theme, scale, outDir) {
    return serialize(async () => {
      const startedAt = performance.now()
      let { worker, failure } = await renderInWorker(id, theme, scale)
      if (failure) {
        // Retry on a clean load to distinguish stale Vite dependencies from fixture failures.
        worker.revision = -1
        ;({ worker, failure } = await renderInWorker(id, theme, scale))
      }
      const pageErrors = worker.pageErrors
      if (failure) {
        return { id, theme, error: failure, pageErrors }
      }
      const path = fixtureScreenshotPath(outDir, id, theme)
      const clip = await worker.page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.fixtureClip ?? 'null')
      )
      await (clip
        ? worker.page.screenshot({ path, clip, animations: 'disabled' })
        : worker.page
            .locator('#component-fixture-frame')
            .screenshot({ path, animations: 'disabled' }))
      return { id, theme, path, ms: Math.round(performance.now() - startedAt), pageErrors }
    })
  }

  function markSourceChanged() {
    sourceRevision += 1
  }

  return { listFixtures, screenshotFixture, markSourceChanged }
}
