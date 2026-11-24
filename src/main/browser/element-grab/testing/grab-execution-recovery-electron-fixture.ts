import { createServer, type ServerResponse } from 'node:http'
import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { executeGrabScript, grabDocumentScope, requestGrabExecution } from '../grab-guest-execution'

/** Why the slow-load teardowns settled as they did; printed by the fixture, never asserted. */
export const recoveryDiagnostics: Record<string, unknown> = {}

/** Exercise legitimate load waiting, cancelled old-document work and recovery on the same native guest. */
export async function verifyGrabExecutionRecovery(
  guest: WebContents,
  manager: BrowserManager,
  pageHtml: string
) {
  const loading: { held: ServerResponse | null } = { held: null }
  let requested: (() => void) | undefined
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/hold')) {
      loading.held = response
      requested?.()
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(
      `<link rel="icon" href="data:,"><h1>Synthetic loading page</h1><img src="/hold${request.url}">`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing synthetic server port')
  }
  const url = `http://127.0.0.1:${address.port}`
  const freshDocument = (): Promise<void> =>
    guest.loadURL(`data:text/html,${encodeURIComponent(pageHtml)}`)
  const startLoad = async (
    path: string
  ): Promise<{ loaded: Promise<void>; release: () => void }> => {
    const arrived = new Promise<void>((resolve) => {
      requested = resolve
    })
    const loaded = guest.loadURL(url + path)
    await arrived
    return {
      loaded,
      release: () => {
        loading.held?.end('')
        loading.held = null
      }
    }
  }
  try {
    const slow = await startLoad('/slow')
    const loadingObserved = guest.isLoadingMainFrame()
    const started = Date.now()
    const since = (): number => Date.now() - started
    const scopeAtCall = grabDocumentScope(guest)
    Object.assign(recoveryDiagnostics, {
      scopeAtCall: { current: scopeAtCall.current, documentId: scopeAtCall.documentId }
    })
    const teardown = manager.setGrabMode('page-1', false, guest).then((done) => {
      recoveryDiagnostics.teardownSettledMs = since()
      return done
    })
    const contended = manager.setGrabMode('page-1', false, guest).then((done) => {
      recoveryDiagnostics.contendedSettledMs = since()
      return done
    })
    // Network delivery outlasts the old execution cap; assert the operation's outcome, not elapsed time.
    await new Promise((resolve) => setTimeout(resolve, 2_300))
    recoveryDiagnostics.releasedMs = since()
    slow.release()
    await slow.loaded
    recoveryDiagnostics.loadedMs = since()
    const slowLoadFinished = await teardown
    const contendedLoadFinished = await contended
    const scopeAfter = grabDocumentScope(guest)
    Object.assign(recoveryDiagnostics, {
      scopeAfter: {
        same: scopeAfter === scopeAtCall,
        current: scopeAfter.current,
        documentId: scopeAfter.documentId
      },
      loadingAfter: guest.isLoadingMainFrame(),
      // Does the loaded page produce frames, and what does a clean run now report?
      paint: await guest.executeJavaScript(`new Promise((resolve) => {
        const start = performance.now();
        const timer = setTimeout(() => resolve('no frame in 2000ms'), 2000);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timer); resolve('frames after ' + Math.round(performance.now() - start) + 'ms');
        }));
      })`),
      cleanProbe: await requestGrabExecution(guest, '', { clean: true }),
      cleanProbeSettledMs: since()
    })

    const cancelled = await startLoad('/cancel')
    const abort = new AbortController()
    const obsolete = executeGrabScript(guest, '(window.__obsoleteGrabCode = true, true)', {
      signal: abort.signal
    })
    abort.abort()
    const cancelledLoad = await obsolete
    cancelled.release()
    await cancelled.loaded
    await freshDocument()
    const obsoleteCodeAbsent = await guest.executeJavaScript(
      'window.__obsoleteGrabCode === undefined'
    )

    const lost = executeGrabScript(
      guest,
      '(window.__executionStarted = true, new Promise(() => {}))'
    )
    const deadline = Date.now() + 5_000
    while (!(await guest.executeJavaScript('window.__executionStarted === true'))) {
      if (Date.now() > deadline) {
        throw new Error('Pending native execution did not begin')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const crashed = new Promise<void>((resolve) =>
      guest.once('render-process-gone', () => resolve())
    )
    guest.forcefullyCrashRenderer()
    await crashed
    const processLoss = await lost
    await freshDocument()
    const recovered = await executeGrabScript(guest, 'true')
    return {
      loadingObserved,
      slowLoadFinished,
      contendedLoadFinished,
      cancelledLoad,
      obsoleteCodeAbsent,
      processLoss,
      recovered
    }
  } finally {
    loading.held?.end('')
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
