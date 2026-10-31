// Unit-tests the pure mapping helpers only. connectEvenHubBridge() itself requires a live
// EvenAppBridge (WebView/hardware) and is intentionally untested here — see the header
// comment in even-hub-bridge.ts. Deliberately imports no SDK types: the payload shapes below
// are plain data structurally compatible with the SDK's models.
import { describe, expect, it } from 'vitest'
import {
  flattenDeviceSnapshot,
  mapEvenHubEventToRawEvent,
  mapStartUpPageCreateResult,
  toSdkListContainerPayload,
  toSdkPagePayload,
  toSdkTextContainerPayload,
  toSdkTextContainerUpgradePayload
} from './even-hub-bridge'
import type { HudListContainerSpec, HudPageBuild, HudTextContainerSpec } from './glasses-bridge'

const textSpec: HudTextContainerSpec = {
  kind: 'text',
  id: 1,
  name: 'header',
  x: 0,
  y: 0,
  width: 576,
  height: 36,
  content: 'hello',
  isEventCapture: 0,
  borderWidth: 1,
  borderColor: 2,
  borderRadius: 3,
  paddingLength: 4
}

const listSpec: HudListContainerSpec = {
  kind: 'list',
  id: 2,
  name: 'body',
  x: 0,
  y: 36,
  width: 576,
  height: 216,
  items: ['one', 'two'],
  isEventCapture: 1,
  showSelectionBorder: true
}

describe('toSdkTextContainerPayload', () => {
  it('maps geometry/content/border fields to SDK property names', () => {
    expect(toSdkTextContainerPayload(textSpec)).toEqual({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 36,
      containerID: 1,
      containerName: 'header',
      isEventCapture: 0,
      content: 'hello',
      borderWidth: 1,
      borderColor: 2,
      borderRadius: 3,
      paddingLength: 4
    })
  })
})

describe('toSdkListContainerPayload', () => {
  it('maps items into itemContainer with itemCount/itemName/select-border flag', () => {
    expect(toSdkListContainerPayload(listSpec)).toEqual({
      xPosition: 0,
      yPosition: 36,
      width: 576,
      height: 216,
      containerID: 2,
      containerName: 'body',
      isEventCapture: 1,
      borderWidth: undefined,
      borderColor: undefined,
      borderRadius: undefined,
      paddingLength: undefined,
      itemContainer: {
        itemCount: 2,
        itemWidth: 576,
        isItemSelectBorderEn: 1,
        itemName: ['one', 'two']
      }
    })
  })

  it('maps showSelectionBorder: false to isItemSelectBorderEn: 0', () => {
    const result = toSdkListContainerPayload({ ...listSpec, showSelectionBorder: false })
    expect(result.itemContainer.isItemSelectBorderEn).toBe(0)
  })
})

describe('toSdkPagePayload', () => {
  it('splits containers into textObject/listObject and counts the total', () => {
    const page: HudPageBuild = { containers: [textSpec, listSpec] }
    const payload = toSdkPagePayload(page)
    expect(payload.containerTotalNum).toBe(2)
    expect(payload.textObject).toHaveLength(1)
    expect(payload.listObject).toHaveLength(1)
    expect(payload.textObject[0]?.containerID).toBe(1)
    expect(payload.listObject[0]?.containerID).toBe(2)
  })
})

describe('mapStartUpPageCreateResult', () => {
  it.each([
    [0, 'success'],
    [1, 'invalid'],
    [2, 'oversize'],
    [3, 'outOfMemory'],
    [99, 'invalid']
  ] as const)('maps code %d to %s', (code, expected) => {
    expect(mapStartUpPageCreateResult(code)).toBe(expected)
  })
})

describe('toSdkTextContainerUpgradePayload', () => {
  it('fills contentLength from the caller-supplied previous length, offset always 0', () => {
    const result = toSdkTextContainerUpgradePayload(
      { id: 1, name: 'body', content: 'new text' },
      42
    )
    expect(result).toEqual({
      containerID: 1,
      containerName: 'body',
      contentOffset: 0,
      contentLength: 42,
      content: 'new text'
    })
  })
})

describe('mapEvenHubEventToRawEvent', () => {
  it('maps listEvent to source: list with index/name/containerId', () => {
    expect(
      mapEvenHubEventToRawEvent({
        listEvent: {
          containerID: 2,
          currentSelectItemIndex: 3,
          currentSelectItemName: 'three',
          eventType: 0
        }
      })
    ).toEqual({
      source: 'list',
      eventType: 0,
      containerId: 2,
      listItemIndex: 3,
      listItemName: 'three'
    })
  })

  it('maps textEvent to source: text', () => {
    expect(mapEvenHubEventToRawEvent({ textEvent: { containerID: 1, eventType: 4 } })).toEqual({
      source: 'text',
      eventType: 4,
      containerId: 1
    })
  })

  it('maps sysEvent to source: sys', () => {
    expect(mapEvenHubEventToRawEvent({ sysEvent: { eventType: 7 } })).toEqual({
      source: 'sys',
      eventType: 7
    })
  })

  it('returns null when no known payload is present (audio/menu/jsonData-only)', () => {
    expect(mapEvenHubEventToRawEvent({})).toBeNull()
  })
})

describe('flattenDeviceSnapshot', () => {
  it('returns null for null status', () => {
    expect(flattenDeviceSnapshot(null)).toBeNull()
  })

  it('flattens connected/battery/wearing/charging/inCase fields', () => {
    expect(
      flattenDeviceSnapshot({
        connected: true,
        batteryLevel: 80,
        isWearing: true,
        isCharging: false,
        isInCase: false
      })
    ).toEqual({
      connected: true,
      batteryLevel: 80,
      isWearing: true,
      isCharging: false,
      isInCase: false
    })
  })
})
