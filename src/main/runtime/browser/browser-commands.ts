import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { RuntimeBrowserTabCatalog } from './browser-tab-catalog'
import { RuntimeBrowserNavigation } from './browser-navigation'
import { RuntimeBrowserElementActions } from './browser-element-actions'
import { RuntimeBrowserPointerInput } from './browser-pointer-input'
import { RuntimeBrowserCapture } from './browser-capture'
import { RuntimeBrowserNetwork } from './browser-network'
import { RuntimeBrowserStorage } from './browser-storage'
import { RuntimeBrowserTabQueries } from './browser-tab-queries'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'
import { RuntimeBrowserTabClose } from './browser-tab-close'
import { RuntimeBrowserProfiles } from './browser-profiles'
import { RuntimeBrowserScreencasts } from './browser-screencasts'
import { RuntimeBrowserDialogs } from './browser-dialogs'

export class RuntimeBrowserCommands {
  readonly browserSnapshot: RuntimeBrowserCommandTargets['browserSnapshot']
  readonly browserClick: RuntimeBrowserNavigation['browserClick']
  readonly browserGoto: RuntimeBrowserNavigation['browserGoto']
  readonly browserBack: RuntimeBrowserNavigation['browserBack']
  readonly browserReload: RuntimeBrowserNavigation['browserReload']
  readonly browserFill: RuntimeBrowserElementActions['browserFill']
  readonly browserType: RuntimeBrowserElementActions['browserType']
  readonly browserSelect: RuntimeBrowserElementActions['browserSelect']
  readonly browserScroll: RuntimeBrowserElementActions['browserScroll']
  readonly browserHover: RuntimeBrowserElementActions['browserHover']
  readonly browserDrag: RuntimeBrowserElementActions['browserDrag']
  readonly browserUpload: RuntimeBrowserElementActions['browserUpload']
  readonly browserWait: RuntimeBrowserElementActions['browserWait']
  readonly browserCheck: RuntimeBrowserElementActions['browserCheck']
  readonly browserFocus: RuntimeBrowserElementActions['browserFocus']
  readonly browserClear: RuntimeBrowserElementActions['browserClear']
  readonly browserSelectAll: RuntimeBrowserElementActions['browserSelectAll']
  readonly browserKeypress: RuntimeBrowserElementActions['browserKeypress']
  readonly browserDblclick: RuntimeBrowserElementActions['browserDblclick']
  readonly browserScrollIntoView: RuntimeBrowserElementActions['browserScrollIntoView']
  readonly browserGet: RuntimeBrowserElementActions['browserGet']
  readonly browserIs: RuntimeBrowserElementActions['browserIs']
  readonly browserFind: RuntimeBrowserElementActions['browserFind']
  readonly browserHighlight: RuntimeBrowserElementActions['browserHighlight']
  readonly browserExec: RuntimeBrowserElementActions['browserExec']
  readonly browserKeyboardInsertText: RuntimeBrowserPointerInput['browserKeyboardInsertText']
  readonly browserMouseMove: RuntimeBrowserPointerInput['browserMouseMove']
  readonly browserMouseDown: RuntimeBrowserPointerInput['browserMouseDown']
  readonly browserMouseClick: RuntimeBrowserPointerInput['browserMouseClick']
  readonly browserMouseUp: RuntimeBrowserPointerInput['browserMouseUp']
  readonly browserMouseWheel: RuntimeBrowserPointerInput['browserMouseWheel']
  readonly browserScreenshot: RuntimeBrowserCapture['browserScreenshot']
  readonly browserPdf: RuntimeBrowserCapture['browserPdf']
  readonly browserFullScreenshot: RuntimeBrowserCapture['browserFullScreenshot']
  readonly browserCaptureStart: RuntimeBrowserCapture['browserCaptureStart']
  readonly browserCaptureStop: RuntimeBrowserCapture['browserCaptureStop']
  readonly browserConsoleLog: RuntimeBrowserCapture['browserConsoleLog']
  readonly browserEval: RuntimeBrowserCapture['browserEval']
  readonly browserNetworkLog: RuntimeBrowserNetwork['browserNetworkLog']
  readonly browserForward: RuntimeBrowserNavigation['browserForward']
  readonly browserCookieGet: RuntimeBrowserNetwork['browserCookieGet']
  readonly browserCookieSet: RuntimeBrowserNetwork['browserCookieSet']
  readonly browserCookieDelete: RuntimeBrowserNetwork['browserCookieDelete']
  readonly browserSetViewport: RuntimeBrowserNetwork['browserSetViewport']
  readonly browserSetGeolocation: RuntimeBrowserNetwork['browserSetGeolocation']
  readonly browserInterceptEnable: RuntimeBrowserNetwork['browserInterceptEnable']
  readonly browserInterceptDisable: RuntimeBrowserNetwork['browserInterceptDisable']
  readonly browserInterceptList: RuntimeBrowserNetwork['browserInterceptList']
  readonly browserSetDevice: RuntimeBrowserNetwork['browserSetDevice']
  readonly browserSetOffline: RuntimeBrowserNetwork['browserSetOffline']
  readonly browserSetHeaders: RuntimeBrowserNetwork['browserSetHeaders']
  readonly browserSetCredentials: RuntimeBrowserNetwork['browserSetCredentials']
  readonly browserSetMedia: RuntimeBrowserNetwork['browserSetMedia']
  readonly browserDownload: RuntimeBrowserNetwork['browserDownload']
  readonly browserClipboardRead: RuntimeBrowserStorage['browserClipboardRead']
  readonly browserClipboardWrite: RuntimeBrowserStorage['browserClipboardWrite']
  readonly browserStorageLocalGet: RuntimeBrowserStorage['browserStorageLocalGet']
  readonly browserStorageLocalSet: RuntimeBrowserStorage['browserStorageLocalSet']
  readonly browserStorageLocalClear: RuntimeBrowserStorage['browserStorageLocalClear']
  readonly browserStorageSessionGet: RuntimeBrowserStorage['browserStorageSessionGet']
  readonly browserStorageSessionSet: RuntimeBrowserStorage['browserStorageSessionSet']
  readonly browserStorageSessionClear: RuntimeBrowserStorage['browserStorageSessionClear']
  readonly browserTabList: RuntimeBrowserTabQueries['browserTabList']
  readonly browserProceedCertificate: RuntimeBrowserTabQueries['browserProceedCertificate']
  readonly browserTabShow: RuntimeBrowserTabQueries['browserTabShow']
  readonly browserTabCurrent: RuntimeBrowserTabQueries['browserTabCurrent']
  readonly browserTabSwitch: RuntimeBrowserTabQueries['browserTabSwitch']
  readonly browserTabCreate: RuntimeBrowserTabCreation['browserTabCreate']
  readonly browserOpenUrlOnClient: RuntimeBrowserTabCreation['browserOpenUrlOnClient']
  readonly browserTabClose: RuntimeBrowserTabClose['browserTabClose']
  readonly browserTabSetProfile: RuntimeBrowserProfiles['browserTabSetProfile']
  readonly browserTabProfileShow: RuntimeBrowserProfiles['browserTabProfileShow']
  readonly browserTabProfileClone: RuntimeBrowserProfiles['browserTabProfileClone']
  readonly browserProfileList: RuntimeBrowserProfiles['browserProfileList']
  readonly browserProfileCreate: RuntimeBrowserProfiles['browserProfileCreate']
  readonly browserProfileDelete: RuntimeBrowserProfiles['browserProfileDelete']
  readonly browserScreencast: RuntimeBrowserScreencasts['browserScreencast']
  readonly browserDialogAccept: RuntimeBrowserDialogs['browserDialogAccept']
  readonly browserDialogDismiss: RuntimeBrowserDialogs['browserDialogDismiss']

  readonly browserProfileDetectBrowsers: RuntimeBrowserProfiles['browserProfileDetectBrowsers']
  readonly browserProfileImportFromBrowser: RuntimeBrowserProfiles['browserProfileImportFromBrowser']
  readonly browserProfileClearDefaultCookies: RuntimeBrowserProfiles['browserProfileClearDefaultCookies']

  constructor(host: RuntimeBrowserCommandHost) {
    const targets = new RuntimeBrowserCommandTargets(host)
    const catalog = new RuntimeBrowserTabCatalog(host, targets)
    const navigation = new RuntimeBrowserNavigation(host, targets)
    const elements = new RuntimeBrowserElementActions(targets)
    const pointer = new RuntimeBrowserPointerInput(targets)
    const capture = new RuntimeBrowserCapture(targets)
    const network = new RuntimeBrowserNetwork(targets)
    const storage = new RuntimeBrowserStorage(targets)
    const queries = new RuntimeBrowserTabQueries(host, targets, catalog)
    const creation = new RuntimeBrowserTabCreation(host, targets)
    const close = new RuntimeBrowserTabClose(queries, host, targets, catalog)
    const profiles = new RuntimeBrowserProfiles(host, targets, catalog)
    const screencasts = new RuntimeBrowserScreencasts(host, targets, catalog)
    const dialogs = new RuntimeBrowserDialogs(targets, screencasts)
    this.browserProfileDetectBrowsers = profiles.browserProfileDetectBrowsers.bind(profiles)
    this.browserProfileImportFromBrowser = profiles.browserProfileImportFromBrowser.bind(profiles)
    this.browserProfileClearDefaultCookies =
      profiles.browserProfileClearDefaultCookies.bind(profiles)

    this.browserSnapshot = targets.browserSnapshot.bind(targets)
    this.browserClick = navigation.browserClick.bind(navigation)
    this.browserGoto = navigation.browserGoto.bind(navigation)
    this.browserBack = navigation.browserBack.bind(navigation)
    this.browserReload = navigation.browserReload.bind(navigation)
    this.browserFill = elements.browserFill.bind(elements)
    this.browserType = elements.browserType.bind(elements)
    this.browserSelect = elements.browserSelect.bind(elements)
    this.browserScroll = elements.browserScroll.bind(elements)
    this.browserHover = elements.browserHover.bind(elements)
    this.browserDrag = elements.browserDrag.bind(elements)
    this.browserUpload = elements.browserUpload.bind(elements)
    this.browserWait = elements.browserWait.bind(elements)
    this.browserCheck = elements.browserCheck.bind(elements)
    this.browserFocus = elements.browserFocus.bind(elements)
    this.browserClear = elements.browserClear.bind(elements)
    this.browserSelectAll = elements.browserSelectAll.bind(elements)
    this.browserKeypress = elements.browserKeypress.bind(elements)
    this.browserDblclick = elements.browserDblclick.bind(elements)
    this.browserScrollIntoView = elements.browserScrollIntoView.bind(elements)
    this.browserGet = elements.browserGet.bind(elements)
    this.browserIs = elements.browserIs.bind(elements)
    this.browserFind = elements.browserFind.bind(elements)
    this.browserHighlight = elements.browserHighlight.bind(elements)
    this.browserExec = elements.browserExec.bind(elements)
    this.browserKeyboardInsertText = pointer.browserKeyboardInsertText.bind(pointer)
    this.browserMouseMove = pointer.browserMouseMove.bind(pointer)
    this.browserMouseDown = pointer.browserMouseDown.bind(pointer)
    this.browserMouseClick = pointer.browserMouseClick.bind(pointer)
    this.browserMouseUp = pointer.browserMouseUp.bind(pointer)
    this.browserMouseWheel = pointer.browserMouseWheel.bind(pointer)
    this.browserScreenshot = capture.browserScreenshot.bind(capture)
    this.browserPdf = capture.browserPdf.bind(capture)
    this.browserFullScreenshot = capture.browserFullScreenshot.bind(capture)
    this.browserCaptureStart = capture.browserCaptureStart.bind(capture)
    this.browserCaptureStop = capture.browserCaptureStop.bind(capture)
    this.browserConsoleLog = capture.browserConsoleLog.bind(capture)
    this.browserEval = capture.browserEval.bind(capture)
    this.browserNetworkLog = network.browserNetworkLog.bind(network)
    this.browserForward = navigation.browserForward.bind(navigation)
    this.browserCookieGet = network.browserCookieGet.bind(network)
    this.browserCookieSet = network.browserCookieSet.bind(network)
    this.browserCookieDelete = network.browserCookieDelete.bind(network)
    this.browserSetViewport = network.browserSetViewport.bind(network)
    this.browserSetGeolocation = network.browserSetGeolocation.bind(network)
    this.browserInterceptEnable = network.browserInterceptEnable.bind(network)
    this.browserInterceptDisable = network.browserInterceptDisable.bind(network)
    this.browserInterceptList = network.browserInterceptList.bind(network)
    this.browserSetDevice = network.browserSetDevice.bind(network)
    this.browserSetOffline = network.browserSetOffline.bind(network)
    this.browserSetHeaders = network.browserSetHeaders.bind(network)
    this.browserSetCredentials = network.browserSetCredentials.bind(network)
    this.browserSetMedia = network.browserSetMedia.bind(network)
    this.browserDownload = network.browserDownload.bind(network)
    this.browserClipboardRead = storage.browserClipboardRead.bind(storage)
    this.browserClipboardWrite = storage.browserClipboardWrite.bind(storage)
    this.browserStorageLocalGet = storage.browserStorageLocalGet.bind(storage)
    this.browserStorageLocalSet = storage.browserStorageLocalSet.bind(storage)
    this.browserStorageLocalClear = storage.browserStorageLocalClear.bind(storage)
    this.browserStorageSessionGet = storage.browserStorageSessionGet.bind(storage)
    this.browserStorageSessionSet = storage.browserStorageSessionSet.bind(storage)
    this.browserStorageSessionClear = storage.browserStorageSessionClear.bind(storage)
    this.browserTabList = queries.browserTabList.bind(queries)
    this.browserProceedCertificate = queries.browserProceedCertificate.bind(queries)
    this.browserTabShow = queries.browserTabShow.bind(queries)
    this.browserTabCurrent = queries.browserTabCurrent.bind(queries)
    this.browserTabSwitch = queries.browserTabSwitch.bind(queries)
    this.browserTabCreate = creation.browserTabCreate.bind(creation)
    this.browserOpenUrlOnClient = creation.browserOpenUrlOnClient.bind(creation)
    this.browserTabClose = close.browserTabClose.bind(close)
    this.browserTabSetProfile = profiles.browserTabSetProfile.bind(profiles)
    this.browserTabProfileShow = profiles.browserTabProfileShow.bind(profiles)
    this.browserTabProfileClone = profiles.browserTabProfileClone.bind(profiles)
    this.browserProfileList = profiles.browserProfileList.bind(profiles)
    this.browserProfileCreate = profiles.browserProfileCreate.bind(profiles)
    this.browserProfileDelete = profiles.browserProfileDelete.bind(profiles)
    this.browserScreencast = screencasts.browserScreencast.bind(screencasts)
    this.browserDialogAccept = dialogs.browserDialogAccept.bind(dialogs)
    this.browserDialogDismiss = dialogs.browserDialogDismiss.bind(dialogs)
  }
}
