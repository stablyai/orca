import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('serve desktop activation wiring', () => {
  const entrySource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const preflightSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const runtimeSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
    'utf8'
  )
  const runtimeServiceSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-runtime-service.ts'),
    'utf8'
  )
  const windowCoreSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-window-core-services.ts'),
    'utf8'
  )

  it('routes second-instance and windowless app activation through one safety gate', () => {
    expect(preflightSource).toContain('createServeDesktopActivationGate({')
    expect(preflightSource).toContain(
      'acquireSingleInstanceLock(app, options.requestDesktopActivation)'
    )
    expect(entrySource).toContain('createMacAppActivationHandler({')
    expect(runtimeSource).toContain("app.on('activate', options.handleMacAppActivation)")
    expect(runtimeServiceSource).toContain('getDesktopWindowStatus,')
  })

  it('settles the persistent provider before headless PTY registration', () => {
    const startupIndex = runtimeSource.indexOf(
      'bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))'
    )
    const serveLaunchIndex = runtimeSource.indexOf('async function launchServeMode(')
    const serveDispatchIndex = runtimeSource.indexOf('  if (serveOptions) {', startupIndex)
    const ptyReadyIndex = runtimeSource.indexOf(
      'await state.localPtyStartupReady',
      serveLaunchIndex
    )
    const providerReadyIndex = runtimeSource.indexOf(
      'await state.localPtyProviderStartupReady',
      serveLaunchIndex
    )
    const headlessRegistrationIndex = runtimeSource.indexOf(
      'await registerHeadlessPtyRuntime(',
      serveLaunchIndex
    )
    const rpcIndex = runtimeSource.indexOf('await runtimeRpc.start()', serveLaunchIndex)

    expect(startupIndex).toBeGreaterThanOrEqual(0)
    expect(serveDispatchIndex).toBeGreaterThan(startupIndex)
    expect(ptyReadyIndex).toBeGreaterThan(serveLaunchIndex)
    expect(providerReadyIndex).toBeGreaterThan(ptyReadyIndex)
    expect(headlessRegistrationIndex).toBeGreaterThan(providerReadyIndex)
    expect(headlessRegistrationIndex).toBeLessThan(rpcIndex)
    expect(runtimeSource).not.toContain(
      'if (!isServeMode) {\n    startDesktopFirstWindowStartupServices()'
    )
  })

  it('publishes the named headless sentinel and only enables promotion after RPC is ready', () => {
    const serveIndex = runtimeSource.indexOf('async function launchServeMode(')
    const sentinelIndex = runtimeSource.indexOf(
      'runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID',
      serveIndex
    )
    const rpcIndex = runtimeSource.indexOf('await runtimeRpc.start()', serveIndex)
    const settleIndex = runtimeSource.indexOf('settleDesktopActivation()', rpcIndex)

    expect(serveIndex).toBeGreaterThanOrEqual(0)
    expect(sentinelIndex).toBeGreaterThan(serveIndex)
    expect(rpcIndex).toBeGreaterThan(sentinelIndex)
    expect(settleIndex).toBeGreaterThan(rpcIndex)
    expect(runtimeSource).not.toContain('runtime.syncWindowGraph(0,')
  })

  it('keeps the headless install policy after desktop promotion', () => {
    expect(windowCoreSource).toContain(
      'updateInstallMode: resolveUpdateInstallMode(state.isServeMode)'
    )
  })
})
