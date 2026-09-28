import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const phaseEvents: string[] = []
let releaseI18n: (() => void) | null = null

vi.mock('./main-process-ready-foundation', () => ({
  initializeReadyFoundation: vi.fn(async () => {
    phaseEvents.push('foundation')
  })
}))
vi.mock('./main-process-ready-runtime', () => ({
  initializeReadyRuntimeServices: vi.fn(async () => {
    phaseEvents.push('runtime-services')
  })
}))
vi.mock('./main-process-i18n-menu', () => ({
  initializeMainProcessI18nAndMenu: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        phaseEvents.push('i18n-start')
        releaseI18n = () => {
          phaseEvents.push('i18n-done')
          resolve()
        }
      })
  )
}))
vi.mock('./main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: vi.fn(async () => {
    phaseEvents.push('launch-start')
    await Promise.resolve()
    phaseEvents.push('window-created')
  })
}))

const { initializeMainProcessReady } = await import('./main-process-ready')

describe('ready-phase concurrency', () => {
  beforeEach(() => {
    phaseEvents.length = 0
    releaseI18n = null
  })

  it('creates the window without waiting for i18n and the native menu', async () => {
    const options = {
      openMainWindow: vi.fn(),
      handleMacAppActivation: vi.fn()
    } as unknown as Parameters<typeof initializeMainProcessReady>[0]

    const ready = initializeMainProcessReady(options)
    // Drain the launch phase's microtasks while i18n is still pending.
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }

    expect(phaseEvents).toEqual([
      'foundation',
      'runtime-services',
      'i18n-start',
      'launch-start',
      'window-created'
    ])

    releaseI18n?.()
    await ready
    expect(phaseEvents.at(-1)).toBe('i18n-done')
  })

  it('still resolves only once i18n and the menu have settled', async () => {
    const options = {
      openMainWindow: vi.fn(),
      handleMacAppActivation: vi.fn()
    } as unknown as Parameters<typeof initializeMainProcessReady>[0]

    const ready = initializeMainProcessReady(options)
    let settled = false
    void ready.then(() => {
      settled = true
    })
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }

    expect(settled).toBe(false)
    releaseI18n?.()
    await ready
    expect(settled).toBe(true)
  })
})

describe('initial proxy application ordering', () => {
  const readStartupSource = (file: string): string =>
    readFileSync(join(process.cwd(), 'src/main/startup', file), 'utf8')

  it('parks the default-session proxy apply instead of blocking window creation on it', () => {
    const foundation = readStartupSource('main-process-ready-foundation.ts')

    expect(foundation).toContain('state.initialProxyApplicationReady = applyElectronProxySettings(')
    // The request guard, not this phase, is what fences fetchers on the proxy; awaiting it here
    // only queued openMainWindow behind a ~24 ms setProxy round trip.
    expect(foundation).not.toMatch(/await\s+(?:state\.)?initialProxyApplication/)
  })

  it('awaits the proxy after the window opens and before the desktop relay starts', () => {
    const launch = readStartupSource('main-process-runtime-launch.ts')
    const desktopStart = launch.indexOf('async function launchDesktopMode(')
    const desktopEnd = launch.indexOf('\nexport async function initializeMainProcessRuntimeLaunch')
    expect(desktopStart).toBeGreaterThanOrEqual(0)
    expect(desktopEnd).toBeGreaterThan(desktopStart)
    const desktop = launch.slice(desktopStart, desktopEnd)

    const windowIndex = desktop.indexOf('openMainWindow()')
    const proxyIndex = desktop.indexOf('await state.initialProxyApplicationReady')
    const relayIndex = desktop.indexOf('new DesktopRelayService(')

    expect(windowIndex).toBeGreaterThanOrEqual(0)
    expect(proxyIndex).toBeGreaterThan(windowIndex)
    expect(relayIndex).toBeGreaterThan(proxyIndex)
  })

  it('waits for i18n before the only launch-phase dialog that reads a translated string', () => {
    const ready = readStartupSource('main-process-ready.ts')
    const launch = readStartupSource('main-process-runtime-launch.ts')

    // Published before the launch phase starts, or the barrier the dialog awaits is still the
    // default resolved promise.
    const publishIndex = ready.indexOf('state.mainProcessI18nReady = ')
    expect(publishIndex).toBeGreaterThanOrEqual(0)
    expect(ready.indexOf('initializeMainProcessRuntimeLaunch(options)')).toBeGreaterThan(
      publishIndex
    )
    expect(launch).toMatch(
      /state\.mainProcessI18nReady\.then\(\(\) =>\s*\n?\s*showRuntimeRpcStartupFailureDialog\(/
    )
  })

  it('keeps headless serve strictly ordered behind the proxy apply', () => {
    const launch = readStartupSource('main-process-runtime-launch.ts')
    const serveStart = launch.indexOf('async function launchServeMode(')
    const serveEnd = launch.indexOf('\nasync function launchDesktopMode(', serveStart)
    expect(serveStart).toBeGreaterThanOrEqual(0)
    expect(serveEnd).toBeGreaterThan(serveStart)
    const serve = launch.slice(serveStart, serveEnd)

    const proxyIndex = serve.indexOf('await state.initialProxyApplicationReady')
    const rpcIndex = serve.indexOf('runtimeRpc.start()')

    expect(proxyIndex).toBeGreaterThanOrEqual(0)
    expect(rpcIndex).toBeGreaterThan(proxyIndex)
  })
})
