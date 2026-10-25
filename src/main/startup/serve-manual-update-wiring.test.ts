import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('manual reporting alongside the native serve updater', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
    'utf8'
  )
  const serve = source.slice(
    source.indexOf('async function launchServeMode('),
    source.indexOf('async function launchDesktopMode(')
  )

  it('records the resolved owner before accepting status RPCs', () => {
    expect(serve.indexOf('setUpdateInstallMode(serveInstallMode)')).toBeGreaterThan(0)
    expect(serve.indexOf('setUpdateInstallMode(serveInstallMode)')).toBeLessThan(
      serve.indexOf('await runtimeRpc.start()')
    )
  })

  it('keeps native updater setup and manual reporting after readiness on the same mode', () => {
    const ready = serve.indexOf('await printServeReady(serveOptions)')
    expect(serve.indexOf('setupHeadlessServeAutoUpdater(store,')).toBeGreaterThan(ready)
    expect(serve).toContain('updateInstallMode: serveInstallMode')
    expect(
      serve.indexOf('startServeManualUpdateReporting({ installMode: serveInstallMode })')
    ).toBeGreaterThan(ready)
  })
})
