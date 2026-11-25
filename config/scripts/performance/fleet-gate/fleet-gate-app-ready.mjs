// Waits for a launched copy's session-ready window; on timeout, saves what every window showed.
import fs from 'node:fs'
import path from 'node:path'

const READY_TIMEOUT_MS = 300_000

function readWindowState() {
  return {
    url: location.href,
    hasApi: Boolean(window.api),
    hasStore: Boolean(window.__store),
    ready: window.__store?.getState().workspaceSessionReady ?? null,
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)
  }
}

/** The session-ready app window; on timeout, writes what every window showed so one run explains the failure. */
export async function waitForAppWindow(app, { label, userDataDir, outDir, stderrTail }) {
  const consoleErrors = []
  const watch = (page) =>
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text().slice(0, 300))
        consoleErrors.splice(0, Math.max(0, consoleErrors.length - 20))
      }
    })
  await app.firstWindow({ timeout: 180_000 })
  app.windows().forEach(watch)
  app.on('window', watch)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const ready = await page
        .evaluate(() => window.__store?.getState().workspaceSessionReady === true)
        .catch(() => false)
      if (ready) {
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  const windows = []
  for (const page of app.windows()) {
    windows.push(await page.evaluate(readWindowState).catch((error) => ({ error: String(error) })))
  }
  fs.mkdirSync(outDir, { recursive: true })
  const stem = path.join(outDir, `not-ready-${label}-${Date.now()}`)
  await app
    .windows()[0]
    ?.screenshot({ path: `${stem}.png` })
    .catch(() => {})
  const userDataFiles = fs.readdirSync(userDataDir).slice(0, 40)
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({ windows, consoleErrors, stderrTail, userDataFiles }, null, 2)}\n`
  )
  console.log(`[fleet-gate] ${label} never became ready: ${JSON.stringify(windows).slice(0, 600)}`)
  console.log(
    `[fleet-gate] console errors: ${JSON.stringify(consoleErrors.slice(-5)).slice(0, 600)}`
  )
  console.log(`[fleet-gate] stderr tail: ${JSON.stringify(stderrTail.slice(-8)).slice(0, 800)}`)
  throw new Error(`${label} not session-ready after ${READY_TIMEOUT_MS / 1000}s (${stem}.json)`)
}
