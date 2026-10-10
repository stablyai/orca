import { defineMethod } from '../core'
import { BrowserTarget } from '../../../../shared/rpc-contract/rpc-param-primitives'
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
  Screenshot,
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
} from './browser-schemas'
import {
  BrowserOpenUrlParams,
  BrowserTabCreateParams
} from '../../../../shared/rpc-contract/browser-tab-create-params'
import { BROWSER_TEXT_METHODS } from './browser-text-rpc-methods'
import { BROWSER_PROFILE_METHODS } from './browser-profile-rpc-methods'
import { CertificateProceed } from '../../../../shared/rpc-contract/browser-core-params'

export const BROWSER_CORE_METHODS = [
  defineMethod({
    name: 'browser.snapshot',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserSnapshot(params)
  }),
  defineMethod({
    name: 'browser.click',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClick(params)
  }),
  defineMethod({
    name: 'browser.goto',
    permission: 'workspace',
    params: Goto,
    handler: async (params, { runtime }) => runtime.browserGoto(params)
  }),
  defineMethod({
    name: 'browser.certificate.proceed',
    permission: 'workspace',
    params: CertificateProceed,
    handler: async (params, { runtime }) => runtime.browserProceedCertificate(params)
  }),
  ...BROWSER_TEXT_METHODS,
  defineMethod({
    name: 'browser.select',
    permission: 'workspace',
    params: Select,
    handler: async (params, { runtime }) => runtime.browserSelect(params)
  }),
  defineMethod({
    name: 'browser.scroll',
    permission: 'workspace',
    params: Scroll,
    handler: async (params, { runtime }) => runtime.browserScroll(params)
  }),
  defineMethod({
    name: 'browser.back',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserBack(params)
  }),
  defineMethod({
    name: 'browser.reload',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserReload(params)
  }),
  defineMethod({
    name: 'browser.screenshot',
    permission: 'workspace',
    params: Screenshot,
    handler: async (params, { runtime }) => runtime.browserScreenshot(params)
  }),
  defineMethod({
    name: 'browser.eval',
    permission: 'workspace',
    params: Eval,
    handler: async (params, { runtime }) => runtime.browserEval(params)
  }),
  defineMethod({
    name: 'browser.tabList',
    permission: 'workspace',
    params: TabList,
    handler: async (params, { runtime }) => runtime.browserTabList(params)
  }),
  defineMethod({
    name: 'browser.tabShow',
    permission: 'workspace',
    params: TabShow,
    handler: async (params, { runtime }) => runtime.browserTabShow(params)
  }),
  defineMethod({
    name: 'browser.tabCurrent',
    permission: 'workspace',
    params: TabCurrent,
    handler: async (params, { runtime }) => runtime.browserTabCurrent(params)
  }),
  defineMethod({
    name: 'browser.tabSwitch',
    permission: 'workspace',
    params: TabSwitch,
    handler: async (params, { runtime }) => runtime.browserTabSwitch(params)
  }),
  defineMethod({
    name: 'browser.tabCreate',
    permission: 'workspace',
    params: BrowserTabCreateParams,
    handler: async (params, { runtime, pairedDeviceId, clientKind }) =>
      pairedDeviceId
        ? runtime.browserTabCreate(params, { pairedDeviceId, clientKind })
        : runtime.browserTabCreate(params, { clientKind })
  }),
  defineMethod({
    name: 'browser.openUrl',
    permission: 'workspace',
    params: BrowserOpenUrlParams,
    handler: async (params, { runtime }) => runtime.browserOpenUrlOnClient(params)
  }),
  defineMethod({
    name: 'browser.tabClose',
    permission: 'workspace',
    params: TabClose,
    handler: async (params, { runtime }) => runtime.browserTabClose(params)
  }),
  ...BROWSER_PROFILE_METHODS,
  defineMethod({
    name: 'browser.hover',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserHover(params)
  }),
  defineMethod({
    name: 'browser.drag',
    permission: 'workspace',
    params: Drag,
    handler: async (params, { runtime }) => runtime.browserDrag(params)
  }),
  defineMethod({
    name: 'browser.upload',
    permission: 'workspace',
    params: Upload,
    handler: async (params, { runtime }) => runtime.browserUpload(params)
  }),
  defineMethod({
    name: 'browser.wait',
    permission: 'workspace',
    params: Wait,
    handler: async (params, { runtime }) => runtime.browserWait(params)
  }),
  defineMethod({
    name: 'browser.check',
    permission: 'workspace',
    params: Check,
    handler: async (params, { runtime }) => runtime.browserCheck(params)
  }),
  defineMethod({
    name: 'browser.focus',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserFocus(params)
  }),
  defineMethod({
    name: 'browser.clear',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClear(params)
  }),
  defineMethod({
    name: 'browser.selectAll',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserSelectAll(params)
  }),
  defineMethod({
    name: 'browser.keypress',
    permission: 'workspace',
    params: Keypress,
    handler: async (params, { runtime }) => runtime.browserKeypress(params)
  }),
  defineMethod({
    name: 'browser.pdf',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserPdf(params)
  }),
  defineMethod({
    name: 'browser.fullScreenshot',
    permission: 'workspace',
    params: FullScreenshot,
    handler: async (params, { runtime }) => runtime.browserFullScreenshot(params)
  }),
  defineMethod({
    name: 'browser.dblclick',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserDblclick(params)
  }),
  defineMethod({
    name: 'browser.forward',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserForward(params)
  }),
  defineMethod({
    name: 'browser.scrollIntoView',
    permission: 'workspace',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserScrollIntoView(params)
  }),
  defineMethod({
    name: 'browser.get',
    permission: 'workspace',
    params: Get,
    handler: async (params, { runtime }) => runtime.browserGet(params)
  }),
  defineMethod({
    name: 'browser.is',
    permission: 'workspace',
    params: Is,
    handler: async (params, { runtime }) => runtime.browserIs(params)
  }),
  defineMethod({
    name: 'browser.find',
    permission: 'workspace',
    params: Find,
    handler: async (params, { runtime }) => runtime.browserFind(params)
  }),
  defineMethod({
    name: 'browser.console',
    permission: 'workspace',
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserConsoleLog(params)
  }),
  defineMethod({
    name: 'browser.network',
    permission: 'workspace',
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserNetworkLog(params)
  }),
  defineMethod({
    name: 'browser.exec',
    permission: 'workspace',
    params: Exec,
    handler: async (params, { runtime }) => runtime.browserExec(params)
  }),
  defineMethod({
    name: 'browser.capture.start',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStart(params)
  }),
  defineMethod({
    name: 'browser.capture.stop',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStop(params)
  }),
  defineMethod({
    name: 'browser.download',
    permission: 'workspace',
    params: SelectorPath,
    handler: async (params, { runtime }) => runtime.browserDownload(params)
  }),
  defineMethod({
    name: 'browser.highlight',
    permission: 'workspace',
    params: Highlight,
    handler: async (params, { runtime }) => runtime.browserHighlight(params)
  })
]
