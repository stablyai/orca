import { onMock } from './pty-ipc-mock-registry'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>
type MainWindowDouble = {
  webContents: { on: { mock: { calls: unknown[][] } }; send: { mock: { calls: unknown[][] } } }
}

/** Accessors for the ipcMain listeners and renderer sends the pty IPC suites assert against. */
export function createPtyIpcListenerAccessors(ctx: {
  handlers: IpcHandlerMap
  mainWindow: MainWindowDouble
  mainWindowIpcEvent: unknown
}) {
  const { handlers, mainWindow, mainWindowIpcEvent } = ctx
  function getPtyWriteListener(): (event: unknown, args: { id: string; data: string }) => void {
    const writeCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:write')
    if (!writeCall) {
      throw new Error('missing pty:write listener')
    }
    return writeCall[1] as (event: unknown, args: { id: string; data: string }) => void
  }
  function getPtyAckDataListener(): (
    event: unknown,
    args: { id: string; charCount?: number; processedChars?: number }
  ) => void {
    const ackCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:ackData')
    if (!ackCall) {
      throw new Error('missing pty:ackData listener')
    }
    return ackCall[1] as (
      event: unknown,
      args: { id: string; charCount?: number; processedChars?: number }
    ) => void
  }

  function getPtySetActiveRendererPtyListener(): (
    event: unknown,
    args: { id: string; active: boolean }
  ) => void {
    const activeCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setActiveRendererPty'
    )
    if (!activeCall) {
      throw new Error('missing pty:setActiveRendererPty listener')
    }
    return activeCall[1] as (event: unknown, args: { id: string; active: boolean }) => void
  }

  function getPtySetRendererPtyVisibleListener(): (
    event: unknown,
    args: { id: string; visible: boolean }
  ) => void {
    const visibleCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setRendererPtyVisible'
    )
    if (!visibleCall) {
      throw new Error('missing pty:setRendererPtyVisible listener')
    }
    return visibleCall[1] as (event: unknown, args: { id: string; visible: boolean }) => void
  }

  function getPtyRendererDispatcherReadyListener(): () => void {
    const readyCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:rendererDispatcherReady'
    )
    if (!readyCall) {
      throw new Error('missing pty:rendererDispatcherReady listener')
    }
    const listener = readyCall[1] as (event: unknown) => void
    // Why: the production handler sender-guards its destructive reconcile, so tests must present as the main window.
    return () => listener(mainWindowIpcEvent)
  }

  function getMainWindowWebContentsListener(eventName: string): (...args: unknown[]) => void {
    const listenerCall = mainWindow.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === eventName
    )
    if (!listenerCall) {
      throw new Error(`missing ${eventName} listener`)
    }
    return listenerCall[1] as (...args: unknown[]) => void
  }

  function getMainFrameNavigationListener(): () => void {
    const listener = getMainWindowWebContentsListener('did-start-navigation')
    return () => listener({ isMainFrame: true, isSameDocument: false })
  }

  function getPtyResizeListener(): (
    event: unknown,
    args: { id: string; cols: number; rows: number }
  ) => void {
    const resizeCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:resize')
    if (!resizeCall) {
      throw new Error('missing pty:resize listener')
    }
    return resizeCall[1] as (
      event: unknown,
      args: { id: string; cols: number; rows: number }
    ) => void
  }

  function getPtySetHiddenRendererPtyListener(): (
    event: unknown,
    args: { id: string; hidden: boolean }
  ) => void {
    const hiddenCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setHiddenRendererPty'
    )
    if (!hiddenCall) {
      throw new Error('missing pty:setHiddenRendererPty listener')
    }
    return hiddenCall[1] as (event: unknown, args: { id: string; hidden: boolean }) => void
  }

  function getPtySetDeliveryInterestListener(): (
    event: unknown,
    args: { id: string; interested: boolean }
  ) => void {
    const interestCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setPtyDeliveryInterest'
    )
    if (!interestCall) {
      throw new Error('missing pty:setPtyDeliveryInterest listener')
    }
    return interestCall[1] as (event: unknown, args: { id: string; interested: boolean }) => void
  }
  const DELIVERY_RESYNC_UNANSWERED_WARNING =
    '[pty] delivery resync probe unanswered — renderer IPC unresponsive'

  function countResyncUnansweredWarnings(warnSpy: { mock: { calls: unknown[][] } }): number {
    return warnSpy.mock.calls.filter((call) => call[0] === DELIVERY_RESYNC_UNANSWERED_WARNING)
      .length
  }

  function getPtyDataSendCalls(): unknown[][] {
    return mainWindow.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pty:data'
    )
  }

  function getDeliveryResyncProbeCalls(): unknown[][] {
    return mainWindow.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pty:requestDeliveryResync'
    )
  }

  function getDeliveryResyncResponseListener(): (
    event: unknown,
    args: { requestId: number; processedCharsByPty: Record<string, number> }
  ) => void {
    const responseCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:deliveryResyncResponse'
    )
    if (!responseCall) {
      throw new Error('missing pty:deliveryResyncResponse listener')
    }
    return responseCall[1] as (
      event: unknown,
      args: { requestId: number; processedCharsByPty: Record<string, number> }
    ) => void
  }
  function reportRendererDeliveryState(args: {
    receivedCharsByPty: Record<string, number>
    processedCharsByPty: Record<string, number>
    heal?: boolean
    rendererPtyDataListenerCount?: number | null
  }): {
    inFlightTotalChars: number
    inFlightPtyCount: number
    msSinceLastAck: number | null
    writtenOff?: { id: string; markerSeq?: number; writtenOffChars: number }[]
  } {
    const handler = handlers.get('pty:reportRendererDeliveryState')
    if (!handler) {
      throw new Error('missing pty:reportRendererDeliveryState handler')
    }
    return handler(null, args) as ReturnType<typeof reportRendererDeliveryState>
  }

  return {
    getPtyWriteListener,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getPtySetRendererPtyVisibleListener,
    getPtyRendererDispatcherReadyListener,
    getMainWindowWebContentsListener,
    getMainFrameNavigationListener,
    getPtyResizeListener,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener,
    DELIVERY_RESYNC_UNANSWERED_WARNING,
    countResyncUnansweredWarnings,
    getPtyDataSendCalls,
    getDeliveryResyncProbeCalls,
    getDeliveryResyncResponseListener,
    reportRendererDeliveryState
  }
}
