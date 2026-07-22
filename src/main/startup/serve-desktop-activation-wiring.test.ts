import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('serve desktop activation wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('routes second-instance and app activation through one safety gate', () => {
    expect(source).toContain('createServeDesktopActivationGate({')
    expect(source).toContain('acquireSingleInstanceLock(app, requestDesktopActivation)')
    expect(source).toContain("app.on('activate', requestDesktopActivation)")
    expect(source).toContain('getDesktopWindowStatus: getDesktopWindowStatus')
  })

  it('settles the persistent provider before headless PTY registration', () => {
    const appReadyIndex = source.indexOf('app.whenReady().then(async () => {')
    const startupIndex = source.indexOf(
      '\n  startTerminalRuntimeStartupServices()\n',
      appReadyIndex
    )
    const serveIndex = source.indexOf('if (serveOptions) {', appReadyIndex)
    const ptyReadyIndex = source.indexOf('await localPtyStartupReady', serveIndex)
    const headlessRegistrationIndex = source.indexOf('registerHeadlessPtyRuntime(', serveIndex)

    expect(startupIndex).toBeGreaterThanOrEqual(0)
    expect(startupIndex).toBeLessThan(serveIndex)
    expect(ptyReadyIndex).toBeGreaterThan(serveIndex)
    expect(headlessRegistrationIndex).toBeGreaterThan(ptyReadyIndex)
    expect(source).not.toContain(
      'if (!isServeMode) {\n    startDesktopFirstWindowStartupServices()'
    )
  })

  it('publishes the named headless sentinel and only enables promotion after RPC is ready', () => {
    const serveIndex = source.indexOf('if (serveOptions) {')
    const sentinelIndex = source.indexOf(
      'runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID',
      serveIndex
    )
    const rpcIndex = source.indexOf('await runtimeRpc.start()', serveIndex)
    const settleIndex = source.indexOf('settleServeDesktopActivation()', rpcIndex)

    expect(serveIndex).toBeGreaterThanOrEqual(0)
    expect(sentinelIndex).toBeGreaterThan(serveIndex)
    expect(rpcIndex).toBeGreaterThan(sentinelIndex)
    expect(settleIndex).toBeGreaterThan(rpcIndex)
    expect(source).not.toContain('runtime.syncWindowGraph(0,')
  })

  it('keeps the headless install policy after desktop promotion', () => {
    expect(source).toContain('updateInstallMode: resolveUpdateInstallMode(isServeMode)')
  })
})
