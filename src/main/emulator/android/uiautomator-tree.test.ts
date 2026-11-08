import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import { parseAndroidBounds, parseUiAutomatorXml } from './uiautomator-tree'

const HIERARCHY_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher3" content-desc="" checkable="false" clickable="false" enabled="true" focused="false" bounds="[0,0][1080,2340]">
    <node index="0" text="Search apps" resource-id="com.android.launcher3:id/search_box" class="android.widget.EditText" package="com.android.launcher3" content-desc="Search Box" clickable="true" enabled="true" focused="true" bounds="[42,180][1038,320]" />
    <node index="1" text="Phone" resource-id="" class="android.widget.TextView" package="com.android.launcher3" content-desc="Phone" clickable="true" enabled="false" focused="false" bounds="[100,400][300,520]" />
  </node>
</hierarchy>`

describe('parseUiAutomatorXml', () => {
  it('maps renamed attributes (class/resource-id/content-desc) on a leaf node', () => {
    const search = parseUiAutomatorXml(HIERARCHY_XML).children[0].children[0]
    expect(search.className).toBe('android.widget.EditText')
    expect(search.text).toBe('Search apps')
    expect(search.resourceId).toBe('com.android.launcher3:id/search_box')
    expect(search.contentDesc).toBe('Search Box')
    expect(search.clickable).toBe(true)
    expect(search.enabled).toBe(true)
    expect(search.focused).toBe(true)
    expect(search.bounds).toEqual({ left: 42, top: 180, right: 1038, bottom: 320 })
  })

  it('decodes XML entities in attribute values', () => {
    const node = parseUiAutomatorXml(
      '<hierarchy><node class="x" text="Tom &amp; Jerry &lt;3&gt;" /></hierarchy>'
    ).children[0]
    expect(node.text).toBe('Tom & Jerry <3>')
  })

  it('throws EmulatorError(emulator_error) on truncated XML', () => {
    const truncated = '<hierarchy><node class="a"'
    expect(() => parseUiAutomatorXml(truncated)).toThrowError(EmulatorError)
    try {
      parseUiAutomatorXml(truncated)
      throw new Error('expected parseUiAutomatorXml to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(EmulatorError)
      expect((error as EmulatorError).code).toBe('emulator_error')
    }
  })
})

describe('parseAndroidBounds', () => {
  it('parses negative coordinates for off-screen elements', () => {
    expect(parseAndroidBounds('[-5,10][1080,2340]')).toEqual({
      left: -5,
      top: 10,
      right: 1080,
      bottom: 2340
    })
  })
})
