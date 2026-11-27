import type { RuntimeTerminalDriverState } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { BrowserScreencastResult } from '../../../shared/browser/runtime/runtime-browser-contracts'
import { runWithRequestedPageUrl } from '../../browser/cdp/input/browser-expected-page-url'
import type { RuntimeBrowserCommandHost } from '../browser/commands/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../browser/commands/browser-commands'
import type { RuntimeEmulatorCommands } from '../emulator/runtime-emulator-commands'
import type { RuntimeBrowserScreencastController } from '../browser/screencast/runtime-browser-screencast-controller'
import { createRuntimeBrowserCommands } from '../browser/installation/runtime-browser-commands-factory'
import type { RuntimeJiraCommands } from '../integrations/jira/runtime-jira-commands'
import type { RpcBinarySender } from '../rpc/transports/rpc-binary-sender'
import {
  bindLazyAsyncMethods,
  EMULATOR_COMMAND_NAMES,
  JIRA_ASYNC_COMMAND_NAMES
} from './lazy-edge-command-bindings'

type PublicMethods<T> = Pick<T, keyof T>
type BrowserSurface = Omit<PublicMethods<RuntimeBrowserCommands>, 'browserScreencast'> & {
  browserScreencast(
    params: Parameters<RuntimeBrowserCommands['browserScreencast']>[0],
    options: {
      connectionId?: string
      pairedDeviceId?: string
      clientKind?: 'mobile' | 'runtime'
      sendBinary?: RpcBinarySender
      signal?: AbortSignal
      emit: (result: BrowserScreencastResult) => void
    }
  ): Promise<void>
}

export type RuntimeEdgeCommandSurface = BrowserSurface &
  PublicMethods<RuntimeJiraCommands> &
  PublicMethods<RuntimeEmulatorCommands>

type ScreencastDependencies = ConstructorParameters<typeof RuntimeBrowserScreencastController>[0]
type EmulatorHost = ConstructorParameters<typeof RuntimeEmulatorCommands>[0]

const BROWSER_COMMAND_NAMES = [
  'browserSnapshot',
  'browserClick',
  'browserGoto',
  'browserFill',
  'browserType',
  'browserSelect',
  'browserScroll',
  'browserBack',
  'browserReload',
  'browserZoom',
  'browserSiteDisplay',
  'browserSetSiteColorScheme',
  'browserStop',
  'browserFindInPage',
  'browserStopFindInPage',
  'browserReplaceMisspelling',
  'browserAddWordToDictionary',
  'browserSaveImage',
  'browserReadImage',
  'browserSetAudioMuted',
  'browserScreenshot',
  'browserScreencast',
  'browserEval',
  'browserTabList',
  'browserProceedCertificate',
  'browserTabShow',
  'browserTabCurrent',
  'browserTabAnnotations',
  'browserTabSwitch',
  'browserHover',
  'browserDrag',
  'browserUpload',
  'browserWait',
  'browserCheck',
  'browserFocus',
  'browserClear',
  'browserSelectAll',
  'browserKeypress',
  'browserPdf',
  'browserFullScreenshot',
  'browserCookieGet',
  'browserCookieSet',
  'browserCookieDelete',
  'browserSetViewport',
  'browserSetGeolocation',
  'browserInterceptEnable',
  'browserInterceptDisable',
  'browserInterceptList',
  'browserCaptureStart',
  'browserCaptureStop',
  'browserConsoleLog',
  'browserNetworkLog',
  'browserDblclick',
  'browserForward',
  'browserScrollIntoView',
  'browserGet',
  'browserIs',
  'browserKeyboardInsertText',
  'browserMouseMove',
  'browserMouseDown',
  'browserMouseClick',
  'browserMouseUp',
  'browserMouseWheel',
  'browserDropFiles',
  'browserFind',
  'browserSetDevice',
  'browserSetOffline',
  'browserSetHeaders',
  'browserSetCredentials',
  'browserSetMedia',
  'browserClipboardRead',
  'browserClipboardWrite',
  'browserDialogAccept',
  'browserDialogDismiss',
  'browserGrabSetMode',
  'browserGrabAwait',
  'browserGrabCancel',
  'browserGrabPickedPresent',
  'browserGrabCaptureSelection',
  'browserGrabExtractHover',
  'browserGrabViewportBridge',
  'browserGrabWatch',
  'browserStorageLocalGet',
  'browserStorageLocalSet',
  'browserStorageLocalClear',
  'browserStorageSessionGet',
  'browserStorageSessionSet',
  'browserStorageSessionClear',
  'browserDownload',
  'browserHighlight',
  'browserExec',
  'browserTabCreate',
  'browserOpenUrlOnClient',
  'browserTabSetProfile',
  'browserTabProfileShow',
  'browserTabProfileClone',
  'browserProfileList',
  'browserProfileCreate',
  'browserProfileDelete',
  'browserCloseServerPagesOfMissingProfiles',
  'browserProfileDetectBrowsers',
  'browserProfileImportFromBrowser',
  'browserProfileClearGoogleCookies',
  'browserProfileClearDefaultCookies',
  'browserProfileClearCookies',
  'browserTabClose'
] as const satisfies readonly (keyof RuntimeBrowserCommands)[]

function bindBrowserMethods<T extends object>(
  instance: T,
  names: readonly (keyof T)[]
): Partial<PublicMethods<T>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fromEntries loses the key type of the names it was built from.
  return Object.fromEntries(
    names.map((name) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every name in BROWSER_COMMAND_NAMES is checked against RuntimeBrowserCommands, whose members are all methods.
      const method = (instance[name] as (...args: unknown[]) => unknown).bind(instance)
      return [name, (...args: unknown[]) => runWithRequestedPageUrl(args[0], () => method(...args))]
    })
  ) as Partial<PublicMethods<T>>
}

export class RuntimeEdgeCommandController {
  private jiraInstance: RuntimeJiraCommands | null = null
  private jiraPromise: Promise<RuntimeJiraCommands> | null = null
  private readonly jiraHost: ConstructorParameters<typeof RuntimeJiraCommands>[0]
  private emulatorInstance: RuntimeEmulatorCommands | null = null
  private emulatorPromise: Promise<RuntimeEmulatorCommands> | null = null
  private readonly emulatorHost: EmulatorHost
  private readonly browser: RuntimeBrowserCommands
  private screencasts: RuntimeBrowserScreencastController | null = null
  private screencastsPromise: Promise<RuntimeBrowserScreencastController> | null = null
  private readonly screencastDeps: ScreencastDependencies
  readonly surface: RuntimeEdgeCommandSurface

  constructor(args: {
    browserHost: RuntimeBrowserCommandHost
    jiraHost: ConstructorParameters<typeof RuntimeJiraCommands>[0]
    screencast: Omit<ScreencastDependencies, 'getCommands'>
    emulatorHost: EmulatorHost
    getBrowserCommands?: () => RuntimeBrowserCommands
  }) {
    this.jiraHost = args.jiraHost
    this.emulatorHost = args.emulatorHost
    this.browser = createRuntimeBrowserCommands(args.browserHost)
    this.screencastDeps = {
      ...args.screencast,
      getCommands: () => args.getBrowserCommands?.() ?? this.browser
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bound name lists are checked against the classes above; spreading loses their key types.
    this.surface = {
      ...bindLazyAsyncMethods(() => this.loadJira(), JIRA_ASYNC_COMMAND_NAMES),
      jiraCancelGenerateIssueSummary: (cancelArgs, owner) =>
        this.jiraInstance
          ? this.jiraInstance.jiraCancelGenerateIssueSummary(cancelArgs, owner)
          : { ok: true },
      ...bindBrowserMethods(this.browser, BROWSER_COMMAND_NAMES),
      ...bindLazyAsyncMethods(() => this.loadEmulator(), EMULATOR_COMMAND_NAMES),
      browserScreencast: async (params, options) =>
        (await this.loadScreencasts()).start(params, options)
    } as RuntimeEdgeCommandSurface
  }

  private loadJira(): Promise<RuntimeJiraCommands> {
    if (this.jiraInstance) {
      return Promise.resolve(this.jiraInstance)
    }
    if (!this.jiraPromise) {
      this.jiraPromise = import('../integrations/jira/runtime-jira-commands')
        .then(({ RuntimeJiraCommands }) => {
          this.jiraInstance = new RuntimeJiraCommands(this.jiraHost)
          return this.jiraInstance
        })
        .catch((error: unknown) => {
          this.jiraPromise = null
          throw error
        })
    }
    return this.jiraPromise
  }

  private loadEmulator(): Promise<RuntimeEmulatorCommands> {
    if (this.emulatorInstance) {
      return Promise.resolve(this.emulatorInstance)
    }
    if (!this.emulatorPromise) {
      this.emulatorPromise = Promise.all([
        import('../emulator/runtime-emulator-commands'),
        this.emulatorHost.ensureEmulatorBridge?.() ?? Promise.resolve(null)
      ])
        .then(([{ RuntimeEmulatorCommands }]) => {
          this.emulatorInstance = new RuntimeEmulatorCommands(this.emulatorHost)
          return this.emulatorInstance
        })
        .catch((error: unknown) => {
          this.emulatorPromise = null
          throw error
        })
    }
    return this.emulatorPromise
  }

  private loadScreencasts(): Promise<RuntimeBrowserScreencastController> {
    if (this.screencasts) {
      return Promise.resolve(this.screencasts)
    }
    if (!this.screencastsPromise) {
      this.screencastsPromise =
        import('../browser/screencast/runtime-browser-screencast-controller')
          .then(({ RuntimeBrowserScreencastController }) => {
            this.screencasts = new RuntimeBrowserScreencastController(this.screencastDeps)
            return this.screencasts
          })
          .catch((error: unknown) => {
            this.screencastsPromise = null
            throw error
          })
    }
    return this.screencastsPromise
  }

  cancelScreencast(browserPageId: string): void {
    this.screencasts?.cancelMobilePage(browserPageId, true)
  }

  publishBrowserDriver(browserPageId: string, driver: RuntimeTerminalDriverState): void {
    this.screencasts?.publishDriver(browserPageId, driver)
  }

  getBrowserRemoteViewerPages(): string[] {
    return this.screencasts?.getRemoteViewerPages() ?? []
  }

  getBrowserCommands(): RuntimeBrowserCommands {
    return this.browser
  }
}
