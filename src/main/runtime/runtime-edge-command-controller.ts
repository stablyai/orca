import type { BrowserScreencastResult } from '../../shared/runtime-types'
import type { RuntimeBrowserCommands, RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeEmulatorCommands } from './orca-runtime-emulator'
import { RuntimeBrowserScreencastController } from './runtime-browser-screencast-controller'
import { createRuntimeBrowserCommands } from './runtime-browser-commands-factory'
import { RuntimeJiraCommands } from './runtime-jira-commands'
import { RuntimeMantisBTCommands } from './runtime-mantisbt-commands'

type PublicMethods<T> = Pick<T, keyof T>
type BrowserSurface = Omit<PublicMethods<RuntimeBrowserCommands>, 'browserScreencast'> & {
  browserScreencast(
    params: Parameters<RuntimeBrowserCommands['browserScreencast']>[0],
    options: {
      connectionId?: string
      pairedDeviceId?: string
      clientKind?: 'mobile' | 'runtime'
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      signal?: AbortSignal
      emit: (result: BrowserScreencastResult) => void
    }
  ): Promise<void>
}

export type RuntimeEdgeCommandSurface = BrowserSurface &
  PublicMethods<RuntimeJiraCommands> &
  PublicMethods<RuntimeMantisBTCommands> &
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

function bindNamedMethods<T extends object>(
  instance: T,
  names: readonly (keyof T)[]
): Partial<PublicMethods<T>> {
  return Object.fromEntries(
    names.map((name) => [name, (instance[name] as (...args: unknown[]) => unknown).bind(instance)])
  ) as Partial<PublicMethods<T>>
}

export class RuntimeEdgeCommandController {
  private readonly jira = new RuntimeJiraCommands()
  private readonly mantisBT = new RuntimeMantisBTCommands()
  private readonly browser: RuntimeBrowserCommands
  private readonly screencasts: RuntimeBrowserScreencastController
  private readonly emulator: RuntimeEmulatorCommands
  readonly surface: RuntimeEdgeCommandSurface

  constructor(args: {
    browserHost: RuntimeBrowserCommandHost
    screencast: Omit<ScreencastDependencies, 'getCommands'>
    emulatorHost: EmulatorHost
    getBrowserCommands?: () => RuntimeBrowserCommands
  }) {
    this.browser = createRuntimeBrowserCommands(args.browserHost)
    this.screencasts = new RuntimeBrowserScreencastController({
      ...args.screencast,
      getCommands: () => args.getBrowserCommands?.() ?? this.browser
    })
    this.emulator = new RuntimeEmulatorCommands(args.emulatorHost)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: assembled from bindPrefixedMethods/bindNamedMethods over every command class mixed into this surface (jira, mantisBT, browser, emulator); each helper binds every method whose name matches its prefix/allowlist, so the merged object satisfies the full surface even though each piece's return type is Partial.
    this.surface = {
      ...bindPrefixedMethods(this.jira, 'jira'),
      ...bindPrefixedMethods(this.mantisBT, 'mantisBT'),
      ...bindNamedMethods(this.browser, BROWSER_COMMAND_NAMES),
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
