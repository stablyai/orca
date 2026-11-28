// Unit 2 — the ONLY file in this project allowed to import @evenrealities/even_hub_sdk
// (see even-g2/AGENTS.md / design spec S4). All mapping/conversion logic is factored into
// plain-data pure functions (no SDK types in their signatures) so it's unit-testable without
// a live SDK bridge; connectEvenHubBridge() itself just wires those functions to the real
// EvenAppBridge instance and is intentionally left untested — it requires a live WebView
// bridge/hardware, exercised only via the hardware QA pass (spec R3), not CI.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerUpgrade
} from '@evenrealities/even_hub_sdk'
import type {
  GlassesBridge,
  GlassesDeviceSnapshot,
  GlassesRawEvent,
  HudListContainerSpec,
  HudPageBuild,
  HudTextContainerSpec,
  HudTextUpgrade,
  StartupBuildResult
} from './glasses-bridge'

// ---- Pure mapping helpers -------------------------------------------------
// These operate on plain JSON-shaped data structurally compatible with the SDK's model
// classes (TextContainerProperty, ListContainerProperty, List_ItemEvent, etc.) so tests can
// exercise them without importing @evenrealities/even_hub_sdk at all.

export type SdkTextContainerPayload = {
  xPosition: number
  yPosition: number
  width: number
  height: number
  containerID: number
  containerName: string
  isEventCapture: 0 | 1
  content: string
  borderWidth?: number
  borderColor?: number
  borderRadius?: number
  paddingLength?: number
}

export type SdkListContainerPayload = {
  xPosition: number
  yPosition: number
  width: number
  height: number
  containerID: number
  containerName: string
  isEventCapture: 0 | 1
  borderWidth?: number
  borderColor?: number
  borderRadius?: number
  paddingLength?: number
  itemContainer: {
    itemCount: number
    itemWidth: number
    isItemSelectBorderEn: 0 | 1
    itemName: string[]
  }
}

export function toSdkTextContainerPayload(spec: HudTextContainerSpec): SdkTextContainerPayload {
  return {
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    containerID: spec.id,
    containerName: spec.name,
    isEventCapture: spec.isEventCapture,
    content: spec.content,
    borderWidth: spec.borderWidth,
    borderColor: spec.borderColor,
    borderRadius: spec.borderRadius,
    paddingLength: spec.paddingLength
  }
}

export function toSdkListContainerPayload(spec: HudListContainerSpec): SdkListContainerPayload {
  return {
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    containerID: spec.id,
    containerName: spec.name,
    isEventCapture: spec.isEventCapture,
    borderWidth: spec.borderWidth,
    borderColor: spec.borderColor,
    borderRadius: spec.borderRadius,
    paddingLength: spec.paddingLength,
    itemContainer: {
      itemCount: spec.items.length,
      itemWidth: spec.width,
      isItemSelectBorderEn: spec.showSelectionBorder ? 1 : 0,
      itemName: spec.items
    }
  }
}

export type SdkPagePayload = {
  containerTotalNum: number
  textObject: SdkTextContainerPayload[]
  listObject: SdkListContainerPayload[]
}

// Shared by createStartUpPage and rebuildPage: both SDK containers take the same
// {containerTotalNum, textObject, listObject} shape (Appendix A).
export function toSdkPagePayload(page: HudPageBuild): SdkPagePayload {
  const textObject = page.containers
    .filter((c): c is HudTextContainerSpec => c.kind === 'text')
    .map(toSdkTextContainerPayload)
  const listObject = page.containers
    .filter((c): c is HudListContainerSpec => c.kind === 'list')
    .map(toSdkListContainerPayload)
  return { containerTotalNum: page.containers.length, textObject, listObject }
}

// StartUpPageCreateResult: 0 success, 1 invalid, 2 oversize, 3 outOfMemory (Appendix A).
// Anything unrecognized degrades to 'invalid' (safe default, mirrors the SDK's own
// StartUpPageCreateResult.fromInt behavior for out-of-range host values).
export function mapStartUpPageCreateResult(code: number): StartupBuildResult {
  switch (code) {
    case 0:
      return 'success'
    case 2:
      return 'oversize'
    case 3:
      return 'outOfMemory'
    default:
      return 'invalid'
  }
}

export type SdkTextContainerUpgradePayload = {
  containerID: number
  containerName: string
  contentOffset: number
  contentLength: number
  content: string
}

// contentLength must be the *previously written* content length for this container id
// (tracked by the caller) per spec S4 — the SDK uses it to know how much of the prior
// buffer to overwrite, not the length of the new content.
export function toSdkTextContainerUpgradePayload(
  update: HudTextUpgrade,
  previousContentLength: number
): SdkTextContainerUpgradePayload {
  return {
    containerID: update.id,
    containerName: update.name,
    contentOffset: 0,
    contentLength: previousContentLength,
    content: update.content
  }
}

// Minimal structural shapes of EvenHubEvent's sub-payloads (List_ItemEvent/Text_ItemEvent/
// Sys_ItemEvent's public fields), avoiding an SDK import in the mapper's signature.
export type SdkListEventPayload = {
  containerID?: number
  currentSelectItemIndex?: number
  currentSelectItemName?: string
  eventType?: number
}
export type SdkTextEventPayload = { containerID?: number; eventType?: number }
export type SdkSysEventPayload = { eventType?: number }
export type SdkEvenHubEventPayload = {
  listEvent?: SdkListEventPayload
  textEvent?: SdkTextEventPayload
  sysEvent?: SdkSysEventPayload
}

// audioEvent/menuItemClickEvent/jsonData are ignored in v1 (spec S4) — null means "drop".
export function mapEvenHubEventToRawEvent(event: SdkEvenHubEventPayload): GlassesRawEvent | null {
  if (event.listEvent) {
    const e = event.listEvent
    return {
      source: 'list',
      eventType: e.eventType,
      containerId: e.containerID,
      listItemIndex: e.currentSelectItemIndex,
      listItemName: e.currentSelectItemName
    }
  }
  if (event.textEvent) {
    const e = event.textEvent
    return { source: 'text', eventType: e.eventType, containerId: e.containerID }
  }
  if (event.sysEvent) {
    return { source: 'sys', eventType: event.sysEvent.eventType }
  }
  return null
}

export type SdkDeviceStatusPayload = {
  connected: boolean
  batteryLevel?: number
  isWearing?: boolean
  isCharging?: boolean
  isInCase?: boolean
}

export function flattenDeviceSnapshot(
  status: SdkDeviceStatusPayload | null
): GlassesDeviceSnapshot | null {
  if (!status) {
    return null
  }
  return {
    connected: status.connected,
    batteryLevel: status.batteryLevel,
    isWearing: status.isWearing,
    isCharging: status.isCharging,
    isInCase: status.isInCase
  }
}

// ---- Real bridge wiring ----------------------------------------------------
// Not covered by even-hub-bridge.test.ts: requires a live EvenAppBridge (WebView + Even
// App + hardware or the Even App's own simulator), which isn't available in CI. Every
// branch above this line — the actual mapping logic — is unit-tested; this function is
// thin glue with no conditionals worth testing in isolation from a live bridge.
export async function connectEvenHubBridge(): Promise<GlassesBridge> {
  const bridge = await waitForEvenAppBridge()
  // Last-written content length per container id, needed to fill TextContainerUpgrade's
  // contentLength (spec S4). Seeded from create/rebuild so the first upgradeText() call
  // after a page (re)build has an accurate previous length.
  const contentLengths = new Map<number, number>()
  const seedContentLengths = (page: HudPageBuild): void => {
    for (const c of page.containers) {
      if (c.kind === 'text') {
        contentLengths.set(c.id, c.content.length)
      }
    }
  }
  const buildListContainerProperty = (l: SdkListContainerPayload): ListContainerProperty =>
    new ListContainerProperty({
      ...l,
      itemContainer: new ListItemContainerProperty(l.itemContainer)
    })

  return {
    async createStartUpPage(page: HudPageBuild): Promise<StartupBuildResult> {
      const payload = toSdkPagePayload(page)
      const container = new CreateStartUpPageContainer({
        containerTotalNum: payload.containerTotalNum,
        textObject: payload.textObject.map((t) => new TextContainerProperty(t)),
        listObject: payload.listObject.map(buildListContainerProperty)
      })
      const result = await bridge.createStartUpPageContainer(container)
      seedContentLengths(page)
      return mapStartUpPageCreateResult(result)
    },

    async rebuildPage(page: HudPageBuild): Promise<boolean> {
      const payload = toSdkPagePayload(page)
      const container = new RebuildPageContainer({
        containerTotalNum: payload.containerTotalNum,
        textObject: payload.textObject.map((t) => new TextContainerProperty(t)),
        listObject: payload.listObject.map(buildListContainerProperty)
      })
      const ok = await bridge.rebuildPageContainer(container)
      if (ok) {
        seedContentLengths(page)
      }
      return ok
    },

    async upgradeText(update: HudTextUpgrade): Promise<boolean> {
      const previous = contentLengths.get(update.id) ?? 0
      const payload = toSdkTextContainerUpgradePayload(update, previous)
      const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade(payload))
      if (ok) {
        contentLengths.set(update.id, update.content.length)
      }
      return ok
    },

    async shutDownPage(exitMode: 0 | 1): Promise<boolean> {
      return bridge.shutDownPageContainer(exitMode)
    },

    async getDeviceSnapshot(): Promise<GlassesDeviceSnapshot | null> {
      const info = await bridge.getDeviceInfo()
      if (!info) {
        return null
      }
      return flattenDeviceSnapshot({
        connected: info.status.isConnected(),
        batteryLevel: info.status.batteryLevel,
        isWearing: info.status.isWearing,
        isCharging: info.status.isCharging,
        isInCase: info.status.isInCase
      })
    },

    async setStoredValue(key: string, value: string): Promise<boolean> {
      return bridge.setLocalStorage(key, value)
    },

    async getStoredValue(key: string): Promise<string> {
      return bridge.getLocalStorage(key)
    },

    onRawEvent(cb: (event: GlassesRawEvent) => void): () => void {
      return bridge.onEvenHubEvent((event) => {
        const mapped = mapEvenHubEventToRawEvent(event)
        if (mapped) {
          cb(mapped)
        }
      })
    },

    onDeviceStatusChanged(cb: (snapshot: GlassesDeviceSnapshot) => void): () => void {
      return bridge.onDeviceStatusChanged((status) => {
        const snapshot = flattenDeviceSnapshot({
          connected: status.isConnected(),
          batteryLevel: status.batteryLevel,
          isWearing: status.isWearing,
          isCharging: status.isCharging,
          isInCase: status.isInCase
        })
        if (snapshot) {
          cb(snapshot)
        }
      })
    }
  }
}
