import type { BrowserScreencastResult } from '../../../shared/runtime-browser-contracts'
import { runWithRequestedPageUrl } from '../../browser/cdp/input/browser-expected-page-url'
import type { RuntimeBrowserCommandHost } from '../browser/commands/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../browser/commands/browser-commands'
import { RuntimeEmulatorCommands } from '../emulator/runtime-emulator-commands'
import { RuntimeBrowserScreencastController } from '../browser/screencast/runtime-browser-screencast-controller'
import { createRuntimeBrowserCommands } from '../browser/installation/runtime-browser-commands-factory'
import { RuntimeJiraCommands } from '../integrations/jira/runtime-jira-commands'
import type { RpcBinarySender } from '../rpc/rpc-binary-sender'

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
  'browserScreenshot',
  'browserScreencast',
  'browserEval',
  'browserTabList',
  'browserProceedCertificate',
  'browserTabShow',
  'browserTabCurrent',
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
  'browserProfileDetectBrowsers',
  'browserProfileImportFromBrowser',
  'browserProfileClearGoogleCookies',
  'browserProfileClearDefaultCookies',
  'browserTabClose'
] as const satisfies readonly (keyof RuntimeBrowserCommands)[]

function bindPrefixedMethods<T extends object>(
  instance: T,
  prefix: string
): Partial<PublicMethods<T>> {
  const bound: Record<string, unknown> = {}
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(instance))) {
    if (name.startsWith(prefix)) {
      bound[name] = (instance[name as keyof T] as (...args: unknown[]) => unknown).bind(instance)
    }
  }
  return bound as Partial<PublicMethods<T>>
}

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
  private readonly jira: RuntimeJiraCommands
  private readonly browser: RuntimeBrowserCommands
  private readonly screencasts: RuntimeBrowserScreencastController
  private readonly emulator: RuntimeEmulatorCommands
  readonly surface: RuntimeEdgeCommandSurface

  constructor(args: {
    browserHost: RuntimeBrowserCommandHost
    jiraHost: ConstructorParameters<typeof RuntimeJiraCommands>[0]
    screencast: Omit<ScreencastDependencies, 'getCommands'>
    emulatorHost: EmulatorHost
    getBrowserCommands?: () => RuntimeBrowserCommands
  }) {
    this.jira = new RuntimeJiraCommands(args.jiraHost)
    this.browser = createRuntimeBrowserCommands(args.browserHost)
    this.screencasts = new RuntimeBrowserScreencastController({
      ...args.screencast,
      getCommands: () => args.getBrowserCommands?.() ?? this.browser
    })
    this.emulator = new RuntimeEmulatorCommands(args.emulatorHost)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bound name lists are checked against the classes above; spreading loses their key types.
    this.surface = {
      ...bindPrefixedMethods(this.jira, 'jira'),
      ...bindBrowserMethods(this.browser, BROWSER_COMMAND_NAMES),
      ...bindPrefixedMethods(this.emulator, 'emulator'),
      browserScreencast: (params, options) => this.screencasts.start(params, options)
    } as RuntimeEdgeCommandSurface
  }

  cancelScreencast(browserPageId: string): void {
    this.screencasts.cancelMobilePage(browserPageId, true)
  }

  getBrowserRemoteViewerPages(): string[] {
    return this.screencasts.getRemoteViewerPages()
  }

  getBrowserCommands(): RuntimeBrowserCommands {
    return this.browser
  }
}
