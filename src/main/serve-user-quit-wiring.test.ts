import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as supervisorMessages from '../shared/serve-update-handoff'
import * as supervision from '../shared/serve-supervision'
import * as menuKeybindings from '../shared/keybindings'
import { QuitTeardownStartGate } from './quit-teardown-start-gate'
import { settleTeardownWithinDeadline, settleWithinMs } from './quit-teardown-deadline'
import { shouldQuitWhenAllWindowsClosed } from './startup/window-all-closed-quit-policy'

function readSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(process.cwd(), path), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
}

function findSyntax(source: ts.Node, matches: (node: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (matches(node)) {
      found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(found).toHaveLength(1)
  return found[0]
}

function functionText(source: ts.SourceFile, name: string): string {
  return findSyntax(
    source,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  ).getText(source)
}

function variableText(source: ts.SourceFile, name: string): string {
  const declaration = findSyntax(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      (name !== 'window' ||
        (node.initializer !== undefined &&
          ts.isCallExpression(node.initializer) &&
          node.initializer.expression.getText(source) === 'createMainWindow'))
  )
  return declaration.parent.parent.getText(source)
}

function registrationText(source: ts.SourceFile, receiver: string, event: string): string {
  return findSyntax(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === `${receiver}.on` &&
      node.arguments[0]?.getText(source) === `'${event}'`
  ).parent.getText(source)
}

function evaluate(source: string, context: Record<string, unknown>): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  runInNewContext(result.outputText, context)
}

// The callbacks and teardown are the shipped registrations; services outside quit are stubs.
async function loadQuitWiring(
  options: {
    veto?: boolean
    confirmation?: boolean
    update?: boolean
    quitThrows?: boolean
    sendDeferred?: boolean
    sendFailure?: 'callback' | 'throw' | 'backpressure'
    connected?: boolean
  } = {}
) {
  const app = new EventEmitter() as EventEmitter & { quit(): void }
  let aborted: (() => void) | undefined
  let completed = false
  let deferConfirmation = options.confirmation === true
  let lastEvent: { preventDefault(): void; prevented: boolean } | undefined
  let completeSend: (() => void) | undefined
  let recoveryPromptQuit: (() => void) | undefined
  const warn = vi.fn()
  const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
    if (options.sendFailure === 'throw') {
      throw new Error('IPC send failed')
    }
    completeSend = () =>
      callback(options.sendFailure === 'callback' ? new Error('IPC send failed') : null)
    if (!options.sendDeferred) {
      queueMicrotask(completeSend)
    }
    return options.sendFailure !== 'backpressure'
  })
  const quitEvents: boolean[] = []
  const appQuit = vi.fn(() => {
    if (options.quitThrows) {
      throw new Error('quit rejected')
    }
    app.emit('before-quit')
    if (options.veto) {
      aborted?.()
      return
    }
    if (deferConfirmation) {
      deferConfirmation = false
      return
    }
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      }
    }
    lastEvent = event
    app.emit('will-quit', event)
    quitEvents.push(event.prevented)
    if (!event.prevented) {
      completed = true
    }
  })
  app.quit = appQuit
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() })
  }
  let windowOptions: Record<string, unknown> = {}
  let trayOptions: { onQuit(): void } | undefined
  let applicationMenu: Electron.MenuItemConstructorOptions[] = []
  const storeFlush = vi.fn(async () => undefined)
  const daemonTeardown = vi.fn(async () => undefined)
  const context: Record<string, unknown> = {
    app,
    console: { ...console, warn },
    setTimeout,
    clearTimeout,
    process: {
      env: { ...process.env, [supervision.SERVE_SUPERVISOR_ENV]: '1' },
      connected: options.connected !== false,
      platform: 'linux',
      pid: process.pid,
      send,
      once: vi.fn()
    },
    mainWindow: window,
    store: {
      getSettings: () => ({ appIcon: 'orca' }),
      getUI: () => ({}),
      flushFinalOrThrowAsync: storeFlush,
      freezeWritesAsync: async () => undefined
    },
    isQuitting: false,
    isServeMode: true,
    options: {},
    devInstanceIdentity: { name: 'Orca', isDev: false },
    keybindings: null,
    isQuittingForUpdate: () => options.update === true,
    quitTeardownStartGate: new QuitTeardownStartGate(),
    settleTeardownWithinDeadline,
    settleWithinMs,
    REF_MAINTENANCE_QUIT_DEADLINE_MS: 2_000,
    shouldQuitWhenAllWindowsClosed,
    createMainWindow: (_store: unknown, callbacks: Record<string, unknown>) => {
      windowOptions = callbacks
      return window
    },
    createSystemTray: (callbacks: { onQuit(): void }) => {
      trayOptions = callbacks
      return true
    },
    syncMacMenuBarIcon: () => null,
    agentHookServer: { stop: vi.fn() },
    wslHookRelayManager: { disposeAll: vi.fn() },
    browserManager: { setBrowserGuestStateChangedListener: vi.fn() },
    isDevParentShutdownRequested: () => false,
    disconnectDaemon: daemonTeardown,
    shutdownDaemon: daemonTeardown,
    shutdownTelemetry: async () => undefined,
    shutdownObservability: async () => undefined
  }
  for (const name of [
    'runtime',
    'stats',
    'runtimeRpc',
    'desktopRelayService',
    'agentAwakeService',
    'unsubscribeAgentAwakeStatusChanges',
    'unsubscribeSystemResumeBroadcast',
    'rateLimits',
    'starNag',
    'automations',
    'pluginService',
    'pluginKillListService',
    'pluginMarketplaceService',
    'pluginMarketplaceInstaller',
    'claudeUsage',
    'codexUsage',
    'openCodeUsage'
  ]) {
    context[name] = null
  }
  for (const name of [
    'clearExpectedRendererReload',
    'recordUpdaterLifecycle',
    'logStartupMilestone',
    'stopTccPromptNotice',
    'destroySystemTray',
    'setPluginServiceForRpc',
    'setUnreadDockBadgeCount',
    'killAllPty',
    'openSettingsFromSystemMenu'
  ]) {
    context[name] = vi.fn()
  }
  for (const name of [
    'stopCodexStateDbBackfillRecoveries',
    'beginSshShutdown',
    'shutdownWatchersOnce'
  ]) {
    context[name] = async () => undefined
  }

  const exports: Record<string, unknown> = {}
  const require = createRequire(import.meta.url)
  evaluate(readFileSync(join(process.cwd(), 'src/main/serve-update-handoff.ts'), 'utf8'), {
    ...context,
    exports,
    require: (name: string) => {
      if (name === 'electron') {
        return { app }
      }
      if (name === './persistence') {
        return { getCanonicalUserDataPath: () => '/fixture' }
      }
      if (name === '../shared/serve-update-handoff') {
        return supervisorMessages
      }
      if (name === '../shared/serve-supervision') {
        return supervision
      }
      return require(name)
    }
  })
  Object.assign(context, exports)
  const quitMenuExports: Record<string, unknown> = {}
  evaluate(readFileSync(join(process.cwd(), 'src/main/menu/app-menu-quit-item.ts'), 'utf8'), {
    ...context,
    exports: quitMenuExports,
    require: (name: string) => {
      if (name === '../i18n/main-i18n') {
        return { translateMain: (_key: string, fallback: string) => fallback }
      }
      return require(name)
    }
  })
  const menuExports: Record<string, unknown> = {}
  evaluate(readFileSync(join(process.cwd(), 'src/main/menu/register-app-menu.ts'), 'utf8'), {
    ...context,
    exports: menuExports,
    require: (name: string) => {
      if (name === 'electron') {
        return {
          app,
          BrowserWindow: { getFocusedWindow: () => null },
          Menu: {
            buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => template,
            setApplicationMenu: (menu: Electron.MenuItemConstructorOptions[]) => {
              applicationMenu = menu
            }
          }
        }
      }
      if (name === '../../shared/keybindings') {
        return menuKeybindings
      }
      if (name === '../i18n/main-i18n') {
        return { translateMain: (_key: string, fallback: string) => fallback }
      }
      if (name === './app-menu-selection-item') {
        return { createAppMenuSelectionItem: () => ({}) }
      }
      if (name === './app-menu-quit-item') {
        return quitMenuExports
      }
      return require(name)
    }
  })
  Object.assign(context, menuExports)
  const actions = readSource('src/main/startup/main-window-actions.ts')
  const controller = readSource('src/main/startup/main-window-controller.ts')
  const menu = readSource('src/main/startup/main-process-i18n-menu.ts')
  const quit = readSource('src/main/startup/main-process-quit.ts')
  context.state = context
  context.exports = {}
  context.safelyRevealWindow = vi.fn()
  context.ensureMainI18n = async () => undefined
  context.setMainUiLanguage = async () => undefined
  context.menuInitializationPromise = Promise.resolve()
  context.require = () => ({ closeAllLocalSshBrowserRoutes: async () => undefined })
  for (const source of [actions, controller, menu, quit]) {
    for (const node of source.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !node.importClause?.namedBindings ||
        !ts.isNamedImports(node.importClause.namedBindings)
      ) {
        continue
      }
      for (const binding of node.importClause.namedBindings.elements) {
        const name = binding.name.text
        if (!(name in context)) {
          context[name] = vi.fn(async () => undefined)
        }
      }
    }
  }
  for (const match of quit.text.matchAll(/state\.(\w+)/g)) {
    if (!(match[1] in context)) {
      context[match[1]] = null
    }
  }
  context.presentRendererRecoveryPrompt = vi.fn(async (options: { quit(): void }) => {
    recoveryPromptQuit = options.quit
  })
  evaluate(
    [
      functionText(actions, 'showMainWindowFromTray'),
      functionText(actions, 'requestUserQuit'),
      functionText(actions, 'getSystemTrayOptions'),
      functionText(actions, 'createSystemTrayDeferred'),
      functionText(actions, 'showRendererRecoveryPrompt'),
      variableText(controller, 'window'),
      'createSystemTrayDeferred(window)()',
      functionText(menu, 'initializeMainProcessI18nAndMenu'),
      'menuInitializationPromise = initializeMainProcessI18nAndMenu()',
      variableText(quit, 'daemonDisconnectDone'),
      functionText(quit, 'installBeforeQuitHandler'),
      functionText(quit, 'installWillQuitHandler'),
      functionText(quit, 'installWindowAllClosedHandler'),
      functionText(quit, 'installMainProcessQuitHandlers'),
      'installMainProcessQuitHandlers()'
    ].join('\n'),
    context
  )
  await context.menuInitializationPromise
  const windowContext = {
    mainWindow: window,
    opts: windowOptions,
    state: { resumeBoundsPersistence: vi.fn() },
    clearQuitRendererAckTimer: vi.fn()
  }
  evaluate(
    registrationText(
      readSource('src/main/window/main-window-close-lifecycle.ts'),
      'mainWindow.webContents',
      'will-prevent-unload'
    ),
    windowContext
  )
  aborted = () => window.webContents.emit('will-prevent-unload')
  expect(trayOptions).toBeDefined()
  return {
    app,
    send,
    warn,
    storeFlush,
    daemonTeardown,
    quitEvents,
    quitFromTray: () => trayOptions!.onQuit(),
    quitFromRecoveryPrompt: async () => {
      await (context.showRendererRecoveryPrompt as (count: number) => Promise<void>)(3)
      expect(recoveryPromptQuit).toBeTypeOf('function')
      recoveryPromptQuit?.()
    },
    confirmClose: () => app.emit('window-all-closed'),
    repeatWillQuit: () => app.emit('will-quit', lastEvent),
    completeSend: () => completeSend?.(),
    quitFromMenu: () => {
      const fileMenu = applicationMenu.find((item) => item.label === 'File')
      const exitItem = ((fileMenu?.submenu ?? []) as Electron.MenuItemConstructorOptions[]).find(
        (item) => item.label === 'Exit'
      )
      expect(exitItem?.role).toBeUndefined()
      expect(exitItem?.click).toBeTypeOf('function')
      exitItem?.click?.({} as never, {} as never, {} as never)
    },
    completed: () => completed
  }
}

afterEach(() => vi.useRealTimers())

describe('registered tray user quit wiring', () => {
  it('notifies only a committed user quit while preserving the normal teardown and final quit', async () => {
    const wiring = await loadQuitWiring()
    wiring.quitFromTray()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))

    expect(wiring.send).toHaveBeenCalledOnce()
    expect(wiring.send.mock.calls[0][0]).toEqual({ type: 'orca:serve-user-quit' })
    expect(wiring.storeFlush).toHaveBeenCalledOnce()
    expect(wiring.daemonTeardown).toHaveBeenCalledOnce()
    expect(wiring.quitEvents).toEqual([true, false])
  })

  it('clears intent on the registered renderer veto, leaving a later health shutdown unmarked', async () => {
    const options = { veto: true }
    const wiring = await loadQuitWiring(options)
    wiring.quitFromTray()
    expect(wiring.completed()).toBe(false)
    expect(wiring.send).not.toHaveBeenCalled()
    options.veto = false
    wiring.app.quit()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).not.toHaveBeenCalled()
  })

  it('keeps user intent through renderer close confirmation rather than treating its delay as a veto', async () => {
    const wiring = await loadQuitWiring({ confirmation: true })
    wiring.quitFromTray()
    expect(wiring.send).not.toHaveBeenCalled()
    wiring.confirmClose()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).toHaveBeenCalledOnce()
  })

  it('does not mark an update install as a user stop', async () => {
    const wiring = await loadQuitWiring({ update: true })
    wiring.quitFromTray()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).not.toHaveBeenCalled()
  })

  it('uses the same committed path from the registered File Exit menu', async () => {
    const wiring = await loadQuitWiring()
    wiring.quitFromMenu()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).toHaveBeenCalledOnce()
    expect(wiring.storeFlush).toHaveBeenCalledOnce()
    expect(wiring.daemonTeardown).toHaveBeenCalledOnce()
  })

  it('clears pending intent if app.quit throws before committing teardown', async () => {
    const options = { quitThrows: true }
    const wiring = await loadQuitWiring(options)
    expect(wiring.quitFromTray).toThrow('quit rejected')
    options.quitThrows = false
    wiring.app.quit()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).not.toHaveBeenCalled()
  })

  it('uses the committed path from the registered renderer recovery prompt Quit action', async () => {
    const wiring = await loadQuitWiring()
    await wiring.quitFromRecoveryPrompt()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).toHaveBeenCalledOnce()
    expect(wiring.storeFlush).toHaveBeenCalledOnce()
    expect(wiring.daemonTeardown).toHaveBeenCalledOnce()
  })

  it('sends once and awaits delivery callback across repeated will-quit events', async () => {
    const wiring = await loadQuitWiring({ sendDeferred: true, sendFailure: 'backpressure' })
    wiring.quitFromTray()
    wiring.repeatWillQuit()
    await Promise.resolve()
    expect(wiring.send).toHaveBeenCalledOnce()
    expect(wiring.warn).not.toHaveBeenCalled()
    expect(wiring.completed()).toBe(false)
    wiring.completeSend()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).toHaveBeenCalledOnce()
  })

  it('keeps the existing teardown deadline when the send callback never completes', async () => {
    vi.useFakeTimers()
    const wiring = await loadQuitWiring({ sendDeferred: true })
    wiring.quitFromTray()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(wiring.completed()).toBe(true)
    expect(wiring.send).toHaveBeenCalledOnce()
    expect(wiring.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
      pendingTeardowns: ['serve-user-quit']
    })
  })

  it.each(['callback', 'throw'] as const)(
    'reports %s delivery failure without blocking normal quit',
    async (sendFailure) => {
      const wiring = await loadQuitWiring({ sendFailure })
      wiring.quitFromTray()
      await vi.waitFor(() => expect(wiring.completed()).toBe(true))
      expect(wiring.warn).toHaveBeenCalledWith(
        '[serve] Could not notify supervisor of user quit:',
        expect.any(Error)
      )
    }
  )

  it('does not attempt delivery on a disconnected channel', async () => {
    const wiring = await loadQuitWiring({ connected: false })
    wiring.quitFromTray()
    await vi.waitFor(() => expect(wiring.completed()).toBe(true))
    expect(wiring.send).not.toHaveBeenCalled()
  })
})
