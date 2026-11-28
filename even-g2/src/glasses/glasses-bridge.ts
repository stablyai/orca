// Contract module (Unit 0): types are the deliverable, no logic. Everything renders through
// this interface so the SDK-backed bridge (Unit 2) and MockGlassesBridge (Unit 6) are
// interchangeable, and tests never import @evenrealities/even_hub_sdk.

export type HudTextContainerSpec = {
  kind: 'text'
  id: number // containerID
  name: string // containerName, <=16 chars
  x: number
  y: number
  width: number
  height: number
  content: string // <=1000 chars at build time
  isEventCapture: 0 | 1
  borderWidth?: number // 0-5
  borderColor?: number // 0-16
  borderRadius?: number // 0-10
  paddingLength?: number // 0-32
}

export type HudListContainerSpec = {
  kind: 'list'
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  items: string[] // 1-20 items, each <=64 chars
  isEventCapture: 0 | 1
  showSelectionBorder: boolean // isItemSelectBorderEn
  borderWidth?: number
  borderColor?: number
  borderRadius?: number
  paddingLength?: number
}

export type HudContainerSpec = HudTextContainerSpec | HudListContainerSpec
export type HudPageBuild = { containers: HudContainerSpec[] }

export type HudTextUpgrade = { id: number; name: string; content: string /* <=2000 */ }

export type GlassesDeviceSnapshot = {
  connected: boolean
  batteryLevel?: number
  isWearing?: boolean
  isCharging?: boolean
  isInCase?: boolean
}

// Raw-ish event, minimally unified across listEvent/textEvent/sysEvent.
// Normalization (dedupe, throttle, CLICK-undefined fix) happens in
// glasses-event-normalization.ts, NOT in bridge impls.
export type GlassesRawEvent = {
  source: 'list' | 'text' | 'sys'
  eventType: number | undefined // OsEventTypeList value; undefined === CLICK (SDK quirk)
  containerId?: number
  listItemIndex?: number // may be missing for index 0 (SDK quirk)
  listItemName?: string
}

export type StartupBuildResult = 'success' | 'invalid' | 'oversize' | 'outOfMemory'

export type GlassesBridge = {
  createStartUpPage(page: HudPageBuild): Promise<StartupBuildResult>
  rebuildPage(page: HudPageBuild): Promise<boolean>
  upgradeText(update: HudTextUpgrade): Promise<boolean>
  shutDownPage(exitMode: 0 | 1): Promise<boolean>
  getDeviceSnapshot(): Promise<GlassesDeviceSnapshot | null>
  setStoredValue(key: string, value: string): Promise<boolean> // '' deletes
  getStoredValue(key: string): Promise<string> // '' means absent
  onRawEvent(cb: (event: GlassesRawEvent) => void): () => void
  onDeviceStatusChanged(cb: (snapshot: GlassesDeviceSnapshot) => void): () => void
}
