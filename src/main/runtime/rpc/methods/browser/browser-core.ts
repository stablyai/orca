import { BROWSER_EXTENSION_METHODS } from './browser-extension-rpc-methods'
import { notShared, defineMethod } from '../../core'
import {
  BrowserTarget,
  ExpectUrlBrowserTarget
} from '../../../../../shared/rpc-contract/rpc-param-primitives'
import {
  Check,
  Drag,
  Element,
  Eval,
  Exec,
  Find,
  FullScreenshot,
  Get,
  Goto,
  Highlight,
  Is,
  Keypress,
  LimitParam,
  Scroll,
  Select,
  SelectorPath,
  TabCurrent,
  TabClose,
  TabList,
  TabShow,
  TabSwitch,
  Upload,
  Wait
} from '../../../../../shared/rpc-contract/browser/browser-params'
import * as browserObservationParams from '../../../../../shared/rpc-contract/browser/browser-observation-params'
import {
  BrowserOpenUrlParams,
  BrowserTabCreateParams
} from '../../../../../shared/rpc-contract/browser/browser-tab-create-params'
import { BROWSER_TEXT_METHODS } from './browser-text-rpc-methods'
import { BROWSER_PAGE_LOAD_METHODS } from './browser-page-load-rpc-methods'
import { BROWSER_PAGE_FIND_METHODS } from './browser-page-find-rpc-methods'
import { BROWSER_PAGE_MENU_METHODS } from './browser-page-menu-rpc-methods'
import { BROWSER_PROFILE_METHODS } from './browser-profile-rpc-methods'
import { CertificateProceed } from '../../../../../shared/rpc-contract/browser/browser-core-params'

export const BROWSER_CORE_METHODS = [
  defineMethod({
    name: 'browser.snapshot',
    ...notShared('workspace'),
    params: browserObservationParams.Snapshot,
    handler: async (params, { runtime }) => runtime.browserSnapshot(params)
  }),
  defineMethod({
    name: 'browser.click',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClick(params)
  }),
  defineMethod({
    name: 'browser.goto',
    ...notShared('workspace'),
    params: Goto,
    handler: async (params, { runtime }) => runtime.browserGoto(params)
  }),
  defineMethod({
    name: 'browser.certificate.proceed',
    ...notShared('workspace'),
    params: CertificateProceed,
    handler: async (params, { runtime }) => runtime.browserProceedCertificate(params)
  }),
  ...BROWSER_TEXT_METHODS,
  defineMethod({
    name: 'browser.select',
    ...notShared('workspace'),
    params: Select,
    handler: async (params, { runtime }) => runtime.browserSelect(params)
  }),
  defineMethod({
    name: 'browser.scroll',
    ...notShared('workspace'),
    params: Scroll,
    handler: async (params, { runtime }) => runtime.browserScroll(params)
  }),
  defineMethod({
    name: 'browser.back',
    ...notShared('workspace'),
    params: ExpectUrlBrowserTarget,
    handler: async (params, { runtime }) => runtime.browserBack(params)
  }),
  ...BROWSER_PAGE_LOAD_METHODS,
  ...BROWSER_PAGE_FIND_METHODS,
  ...BROWSER_PAGE_MENU_METHODS,
  defineMethod({
    name: 'browser.screenshot',
    ...notShared('workspace'),
    params: browserObservationParams.Screenshot,
    handler: async (params, { runtime }) => runtime.browserScreenshot(params)
  }),
  defineMethod({
    name: 'browser.eval',
    ...notShared('workspace'),
    params: Eval,
    handler: async (params, { runtime, signal }) => runtime.browserEval(params, signal)
  }),
  defineMethod({
    name: 'browser.tabList',
    ...notShared('workspace'),
    params: TabList,
    handler: async (params, { runtime }) => runtime.browserTabList(params)
  }),
  defineMethod({
    name: 'browser.tabShow',
    ...notShared('workspace'),
    params: TabShow,
    handler: async (params, { runtime }) => runtime.browserTabShow(params)
  }),
  defineMethod({
    name: 'browser.tabCurrent',
    ...notShared('workspace'),
    params: TabCurrent,
    handler: async (params, { runtime }) => runtime.browserTabCurrent(params)
  }),
  defineMethod({
    name: 'browser.tabAnnotations',
    ...notShared('workspace'),
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserTabAnnotations(params)
  }),
  defineMethod({
    name: 'browser.tabSwitch',
    ...notShared('workspace'),
    params: TabSwitch,
    handler: async (params, { runtime }) => runtime.browserTabSwitch(params)
  }),
  defineMethod({
    name: 'browser.tabCreate',
    ...notShared('workspace'),
    params: BrowserTabCreateParams,
    handler: async (params, { runtime, pairedDeviceId, clientKind, signal }) =>
      pairedDeviceId
        ? runtime.browserTabCreate(params, { pairedDeviceId, clientKind, signal })
        : runtime.browserTabCreate(params, { clientKind, signal })
  }),
  defineMethod({
    name: 'browser.openUrl',
    ...notShared('workspace'),
    params: BrowserOpenUrlParams,
    handler: async (params, { runtime, signal }) =>
      runtime.browserOpenUrlOnClient(params, { signal })
  }),
  defineMethod({
    name: 'browser.tabClose',
    ...notShared('workspace'),
    params: TabClose,
    handler: async (params, { runtime }) => runtime.browserTabClose(params)
  }),
  ...BROWSER_PROFILE_METHODS,
  ...BROWSER_EXTENSION_METHODS,
  defineMethod({
    name: 'browser.hover',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserHover(params)
  }),
  defineMethod({
    name: 'browser.drag',
    ...notShared('workspace'),
    params: Drag,
    handler: async (params, { runtime }) => runtime.browserDrag(params)
  }),
  defineMethod({
    name: 'browser.upload',
    ...notShared('workspace'),
    params: Upload,
    handler: async (params, { runtime }) => runtime.browserUpload(params)
  }),
  defineMethod({
    name: 'browser.wait',
    ...notShared('workspace'),
    params: Wait,
    handler: async (params, { runtime }) => runtime.browserWait(params)
  }),
  defineMethod({
    name: 'browser.check',
    ...notShared('workspace'),
    params: Check,
    handler: async (params, { runtime }) => runtime.browserCheck(params)
  }),
  defineMethod({
    name: 'browser.focus',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserFocus(params)
  }),
  defineMethod({
    name: 'browser.clear',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClear(params)
  }),
  defineMethod({
    name: 'browser.selectAll',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserSelectAll(params)
  }),
  defineMethod({
    name: 'browser.keypress',
    ...notShared('workspace'),
    params: Keypress,
    handler: async (params, { runtime }) => runtime.browserKeypress(params)
  }),
  defineMethod({
    name: 'browser.pdf',
    ...notShared('workspace'),
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserPdf(params)
  }),
  defineMethod({
    name: 'browser.fullScreenshot',
    ...notShared('workspace'),
    params: FullScreenshot,
    handler: async (params, { runtime }) => runtime.browserFullScreenshot(params)
  }),
  defineMethod({
    name: 'browser.dblclick',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserDblclick(params)
  }),
  defineMethod({
    name: 'browser.forward',
    ...notShared('workspace'),
    params: ExpectUrlBrowserTarget,
    handler: async (params, { runtime }) => runtime.browserForward(params)
  }),
  defineMethod({
    name: 'browser.scrollIntoView',
    ...notShared('workspace'),
    params: Element,
    handler: async (params, { runtime }) => runtime.browserScrollIntoView(params)
  }),
  defineMethod({
    name: 'browser.get',
    ...notShared('workspace'),
    params: Get,
    handler: async (params, { runtime }) => runtime.browserGet(params)
  }),
  defineMethod({
    name: 'browser.is',
    ...notShared('workspace'),
    params: Is,
    handler: async (params, { runtime }) => runtime.browserIs(params)
  }),
  defineMethod({
    name: 'browser.find',
    ...notShared('workspace'),
    params: Find,
    handler: async (params, { runtime }) => runtime.browserFind(params)
  }),
  defineMethod({
    name: 'browser.console',
    ...notShared('workspace'),
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserConsoleLog(params)
  }),
  defineMethod({
    name: 'browser.network',
    ...notShared('workspace'),
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserNetworkLog(params)
  }),
  defineMethod({
    name: 'browser.exec',
    ...notShared('workspace'),
    params: Exec,
    handler: async (params, { runtime }) => runtime.browserExec(params)
  }),
  defineMethod({
    name: 'browser.capture.start',
    ...notShared('workspace'),
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStart(params)
  }),
  defineMethod({
    name: 'browser.capture.stop',
    ...notShared('workspace'),
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStop(params)
  }),
  defineMethod({
    name: 'browser.download',
    ...notShared('workspace'),
    params: SelectorPath,
    handler: async (params, { runtime }) => runtime.browserDownload(params)
  }),
  defineMethod({
    name: 'browser.highlight',
    ...notShared('workspace'),
    params: Highlight,
    handler: async (params, { runtime }) => runtime.browserHighlight(params)
  })
]
