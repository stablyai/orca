import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../shared/orca-profiles/orca-cloud-team-policy'
import { isTeamFeatureBlocked } from '../orca-profiles/cloud-auth/active-team-capabilities'
import {
  isAgentRpcCaller,
  type RpcCallerIdentity
} from '../runtime/rpc/callers/rpc-caller-identity'
import { BrowserError } from './browser-error'

// Methods a person's desktop, web, or mobile browser pane uses for manual browsing.
const HUMAN_VIEWER_BROWSER_RPC_METHODS = new Set<string>([
  'browser.back',
  'browser.forward',
  'browser.goto',
  'browser.reload',
  'browser.stop',
  'browser.certificate.proceed',
  'browser.dialogAccept',
  'browser.dialogDismiss',
  'browser.pagePromptAnswer',
  'browser.fileChooserAnswer',
  'browser.keyboardInsertText',
  'browser.keypress',
  'browser.mouseClick',
  'browser.mouseDown',
  'browser.mouseMove',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.dropFiles',
  'browser.viewport',
  'browser.zoom',
  'browser.siteDisplay',
  'browser.setSiteColorScheme',
  'browser.setAudioMuted',
  'browser.findInPage',
  'browser.stopFindInPage',
  'browser.replaceMisspelling',
  'browser.addWordToDictionary',
  'browser.saveImage',
  'browser.readImage',
  'browser.tabCreate',
  'browser.tabClose',
  'browser.screencast',
  'browser.screencast.ack',
  'browser.screencast.unsubscribe',
  'browser.screencast.reclaimForDesktop',
  'browser.readPrintPdf',
  'browser.releasePrintPdf',
  'browser.downloadCopyStream',
  'browser.releaseDownloadCopy',
  'browser.profileList',
  'browser.profileCreate',
  'browser.profileDelete',
  'browser.profileDetectBrowsers',
  'browser.profileImportFromBrowser',
  'browser.profileClearGoogleCookies',
  'browser.profileClearDefaultCookies',
  'browser.profileClearCookies',
  'browser.identity.get',
  'browser.identity.set',
  'browser.grab.setMode',
  'browser.grab.await',
  'browser.grab.cancel',
  'browser.grab.pickedPresent',
  'browser.grab.captureSelection',
  'browser.grab.extractHover',
  'browser.grab.viewportBridge',
  'browser.grab.watch',
  'browser.clientHost.attach',
  'browser.clientHost.commandResult',
  'browser.clientHost.requestResult',
  'browser.clientHost.pageMetadata',
  'browser.clientHost.fileChannel.begin',
  'browser.clientHost.fileChannel.read',
  'browser.clientHost.fileChannel.write',
  'browser.clientHost.fileChannel.abort',
  'browser.clientPage.initializationAction'
])

export function isTeamBrowserUseBlocked(): boolean {
  return isTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse)
}

export function assertTeamAllowsBrowserUse(): void {
  if (isTeamBrowserUseBlocked()) {
    throw new BrowserError('browser_use_disabled', 'Browser Use is turned off by your team.')
  }
}

export function assertTeamAllowsBrowserRpc(
  method: string,
  caller: RpcCallerIdentity | undefined
): void {
  if (!method.startsWith('browser.') || !isTeamBrowserUseBlocked()) {
    return
  }
  if (isAgentRpcCaller(caller) || !HUMAN_VIEWER_BROWSER_RPC_METHODS.has(method)) {
    throw new BrowserError('browser_use_disabled', 'Browser Use is turned off by your team.')
  }
}
