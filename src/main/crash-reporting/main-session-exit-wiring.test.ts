import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the call sites that mark a main-process exit as clean or unclean.
 * Source-level because these run inside startup/quit composition with no runtime
 * seam; dropping one leaves every marker unit test green while each normal quit
 * reads as a crash (or a crash as a clean exit) on the next launch.
 */
// Why normalize: nothing pins src/**/*.ts to LF, so a CRLF checkout would fail spuriously.
const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), 'src/main', relativePath), 'utf8').replace(/\r\n/g, '\n')

function bodyAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor)
  expect(start).toBeGreaterThanOrEqual(0)
  return source
    .slice(start + anchor.length)
    .split('\nfunction ')[0]
    .split('\nexport ')[0]
}

describe('main session exit record wiring', () => {
  it('records the will-quit exit only after teardown settles and before app.quit()', () => {
    const body = bodyAfter(readSource('startup/main-process-quit.ts'), "app.on('will-quit'")
    const recordCall = "recordMainSessionExit(updateQuitInProgress ? 'update-install' : 'quit')"
    expect(body.split(recordCall).length - 1).toBe(1)
    const recordAt = body.indexOf(recordCall)
    // Why after teardown: a native crash while tearing down must still read as unclean.
    expect(recordAt).toBeGreaterThan(body.indexOf('settleTeardownWithinDeadline(['))
    expect(recordAt).toBeGreaterThan(body.indexOf('shutdownObservability()'))
    expect(recordAt).toBeLessThan(body.lastIndexOf('app.quit()'))
  })

  it('starts exit tracking after the single-instance lock and feeds it to Crashpad', () => {
    const source = readSource('startup/main-process-preflight.ts')
    const lockAt = source.indexOf('acquireSingleInstanceLock(app,')
    const trackCall = 'const previousUncleanMainSession = startMainSessionExitTracking('
    const trackAt = source.indexOf(trackCall)
    const crashpadAt = source.indexOf('startCrashpadCapture({')
    expect(source.split(trackCall).length - 1).toBe(1)
    // Why after the lock: a losing second instance must not overwrite the running launch's record.
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(trackAt).toBeGreaterThan(lockAt)
    // Why before Crashpad: the unclean verdict picks which dump to read before pruning.
    expect(crashpadAt).toBeGreaterThan(trackAt)
    expect(source.slice(crashpadAt).split('})')[0]).toContain(
      'previousUncleanSessionStartedAtMs: previousUncleanMainSession'
    )
  })

  it('installs the OS shutdown record during observer startup', () => {
    const body = bodyAfter(
      readSource('startup/main-process-observers.ts'),
      'export function initializeMainProcessObservers('
    )
    expect(body).toContain('\n  installOsShutdownExitRecord(powerMonitor, process.platform)')
  })

  it('revokes a provisional exit when the main window aborts a quit', () => {
    const source = readSource('startup/main-window-controller.ts')
    const abortHandler = source.slice(source.indexOf('onQuitAborted: () => {')).split('\n    },')[0]
    expect(abortHandler).toContain('revokeProvisionalMainSessionExit()')
  })
})
