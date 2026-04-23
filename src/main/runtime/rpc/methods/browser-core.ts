import { defineMethod, type RpcMethod } from '../core'
import { BrowserTarget } from '../schemas'
import {
  Check,
  Drag,
  Element,
  Eval,
  Exec,
  Fill,
  Find,
  FullScreenshot,
  Get,
  Goto,
  Highlight,
  Is,
  KeyboardInsert,
  Keypress,
  LimitParam,
  Screenshot,
  Scroll,
  Select,
  SelectorPath,
  TabClose,
  TabCreate,
  TabList,
  TabSwitch,
  Type,
  Upload,
  Wait
} from './browser-schemas'

export const BROWSER_CORE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'browser.snapshot',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserSnapshot(params)
  }),
  defineMethod({
    name: 'browser.click',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClick(params)
  }),
  defineMethod({
    name: 'browser.goto',
    params: Goto,
    handler: async (params, { runtime }) => runtime.browserGoto(params)
  }),
  defineMethod({
    name: 'browser.fill',
    params: Fill,
    handler: async (params, { runtime }) => runtime.browserFill(params)
  }),
  defineMethod({
    name: 'browser.type',
    params: Type,
    handler: async (params, { runtime }) => runtime.browserType(params)
  }),
  defineMethod({
    name: 'browser.select',
    params: Select,
    handler: async (params, { runtime }) => runtime.browserSelect(params)
  }),
  defineMethod({
    name: 'browser.scroll',
    params: Scroll,
    handler: async (params, { runtime }) => runtime.browserScroll(params)
  }),
  defineMethod({
    name: 'browser.back',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserBack(params)
  }),
  defineMethod({
    name: 'browser.reload',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserReload(params)
  }),
  defineMethod({
    name: 'browser.screenshot',
    params: Screenshot,
    handler: async (params, { runtime }) => runtime.browserScreenshot(params)
  }),
  defineMethod({
    name: 'browser.eval',
    params: Eval,
    handler: async (params, { runtime }) => runtime.browserEval(params)
  }),
  defineMethod({
    name: 'browser.tabList',
    params: TabList,
    handler: async (params, { runtime }) => runtime.browserTabList(params)
  }),
  defineMethod({
    name: 'browser.tabSwitch',
    params: TabSwitch,
    handler: async (params, { runtime }) => runtime.browserTabSwitch(params)
  }),
  defineMethod({
    name: 'browser.tabCreate',
    params: TabCreate,
    handler: async (params, { runtime }) => runtime.browserTabCreate(params)
  }),
  defineMethod({
    name: 'browser.tabClose',
    params: TabClose,
    handler: async (params, { runtime }) => runtime.browserTabClose(params)
  }),
  defineMethod({
    name: 'browser.hover',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserHover(params)
  }),
  defineMethod({
    name: 'browser.drag',
    params: Drag,
    handler: async (params, { runtime }) => runtime.browserDrag(params)
  }),
  defineMethod({
    name: 'browser.upload',
    params: Upload,
    handler: async (params, { runtime }) => runtime.browserUpload(params)
  }),
  defineMethod({
    name: 'browser.wait',
    params: Wait,
    handler: async (params, { runtime }) => runtime.browserWait(params)
  }),
  defineMethod({
    name: 'browser.check',
    params: Check,
    handler: async (params, { runtime }) => runtime.browserCheck(params)
  }),
  defineMethod({
    name: 'browser.focus',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserFocus(params)
  }),
  defineMethod({
    name: 'browser.clear',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserClear(params)
  }),
  defineMethod({
    name: 'browser.selectAll',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserSelectAll(params)
  }),
  defineMethod({
    name: 'browser.keypress',
    params: Keypress,
    handler: async (params, { runtime }) => runtime.browserKeypress(params)
  }),
  defineMethod({
    name: 'browser.pdf',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserPdf(params)
  }),
  defineMethod({
    name: 'browser.fullScreenshot',
    params: FullScreenshot,
    handler: async (params, { runtime }) => runtime.browserFullScreenshot(params)
  }),
  defineMethod({
    name: 'browser.dblclick',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserDblclick(params)
  }),
  defineMethod({
    name: 'browser.forward',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserForward(params)
  }),
  defineMethod({
    name: 'browser.scrollIntoView',
    params: Element,
    handler: async (params, { runtime }) => runtime.browserScrollIntoView(params)
  }),
  defineMethod({
    name: 'browser.get',
    params: Get,
    handler: async (params, { runtime }) => runtime.browserGet(params)
  }),
  defineMethod({
    name: 'browser.is',
    params: Is,
    handler: async (params, { runtime }) => runtime.browserIs(params)
  }),
  defineMethod({
    name: 'browser.keyboardInsertText',
    params: KeyboardInsert,
    handler: async (params, { runtime }) => runtime.browserKeyboardInsertText(params)
  }),
  defineMethod({
    name: 'browser.find',
    params: Find,
    handler: async (params, { runtime }) => runtime.browserFind(params)
  }),
  defineMethod({
    name: 'browser.console',
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserConsoleLog(params)
  }),
  defineMethod({
    name: 'browser.network',
    params: LimitParam,
    handler: async (params, { runtime }) => runtime.browserNetworkLog(params)
  }),
  defineMethod({
    name: 'browser.exec',
    params: Exec,
    handler: async (params, { runtime }) => runtime.browserExec(params)
  }),
  defineMethod({
    name: 'browser.capture.start',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStart(params)
  }),
  defineMethod({
    name: 'browser.capture.stop',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserCaptureStop(params)
  }),
  defineMethod({
    name: 'browser.download',
    params: SelectorPath,
    handler: async (params, { runtime }) => runtime.browserDownload(params)
  }),
  defineMethod({
    name: 'browser.highlight',
    params: Highlight,
    handler: async (params, { runtime }) => runtime.browserHighlight(params)
  })
]
