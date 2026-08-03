import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import { parseAndroidBounds, parseUiAutomatorXml } from './uiautomator-tree'

// Realistic `uiautomator dump` output: an XML prolog, a <hierarchy> root, and
// nested self-describing <node> elements (mix of container + self-closing leaf).
const HIERARCHY_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher3" content-desc="" checkable="false" clickable="false" enabled="true" focused="false" bounds="[0,0][1080,2340]">
    <node index="0" text="Search apps" resource-id="com.android.launcher3:id/search_box" class="android.widget.EditText" package="com.android.launcher3" content-desc="Search Box" clickable="true" enabled="true" focused="true" bounds="[42,180][1038,320]" />
    <node index="1" text="Phone" resource-id="" class="android.widget.TextView" package="com.android.launcher3" content-desc="Phone" clickable="true" enabled="false" focused="false" bounds="[100,400][300,520]" />
  </node>
</hierarchy>`

describe('parseUiAutomatorXml', () => {
  it('returns a synthetic root holding the top-level <node> children of <hierarchy>', () => {
    const root = parseUiAutomatorXml(HIERARCHY_XML)
    expect(root.children).toHaveLength(1)
  })

  it('maps attributes and coerces booleans and bounds on a container node', () => {
    const frame = parseUiAutomatorXml(HIERARCHY_XML).children[0]
    expect(frame.className).toBe('android.widget.FrameLayout')
    expect(frame.packageName).toBe('com.android.launcher3')
    expect(frame.clickable).toBe(false)
    expect(frame.enabled).toBe(true)
    expect(frame.focused).toBe(false)
    expect(frame.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 2340 })
    expect(frame.children).toHaveLength(2)
  })

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

  it('gives a childless node an empty children array', () => {
    const search = parseUiAutomatorXml(HIERARCHY_XML).children[0].children[0]
    expect(search.children).toEqual([])
  })

  it('preserves sibling order', () => {
    const frame = parseUiAutomatorXml(HIERARCHY_XML).children[0]
    expect(frame.children[0].text).toBe('Search apps')
    expect(frame.children[1].text).toBe('Phone')
    expect(frame.children[1].enabled).toBe(false)
  })

  it('omits string fields whose attribute is absent or empty', () => {
    const frame = parseUiAutomatorXml(HIERARCHY_XML).children[0]
    // class is present, but text/resource-id/content-desc are "" -> omitted.
    expect('text' in frame).toBe(false)
    expect('resourceId' in frame).toBe(false)
    expect('contentDesc' in frame).toBe(false)
  })

  it('omits boolean and bounds fields when their attributes are absent', () => {
    const only = parseUiAutomatorXml('<hierarchy><node class="android.view.View" /></hierarchy>')
      .children[0]
    expect(only.className).toBe('android.view.View')
    expect('clickable' in only).toBe(false)
    expect('enabled' in only).toBe(false)
    expect('focused' in only).toBe(false)
    expect('bounds' in only).toBe(false)
    expect('text' in only).toBe(false)
    expect(only.children).toEqual([])
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

  it('throws EmulatorError(emulator_error) on non-XML and empty input', () => {
    expect(() => parseUiAutomatorXml('not xml at all')).toThrowError(EmulatorError)
    expect(() => parseUiAutomatorXml('')).toThrowError(EmulatorError)
    expect(() => parseUiAutomatorXml('<hierarchy></node>')).toThrowError(EmulatorError)
  })
})

describe('parseAndroidBounds', () => {
  it('parses a well-formed bounds string', () => {
    expect(parseAndroidBounds('[0,0][1080,2340]')).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 2340
    })
  })

  it('parses negative coordinates for off-screen elements', () => {
    expect(parseAndroidBounds('[-5,10][1080,2340]')).toEqual({
      left: -5,
      top: 10,
      right: 1080,
      bottom: 2340
    })
  })

  it('returns null for malformed input', () => {
    expect(parseAndroidBounds('garbage')).toBeNull()
    expect(parseAndroidBounds('[0,0]')).toBeNull()
    expect(parseAndroidBounds('[0,0][1080]')).toBeNull()
    expect(parseAndroidBounds('')).toBeNull()
  })
})
