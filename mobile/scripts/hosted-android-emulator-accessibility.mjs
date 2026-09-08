import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'

const ACCESSIBILITY_TREE_MAX_BYTES = 2 * 1024 * 1024
const DISPLAY_SIZE_PATTERN = /(?:Override|Physical) size:\s*(\d+)x(\d+)/gu

export async function waitForHostedAndroidAccessibilityControlMatch(
  emulator,
  labels,
  timeoutMs,
  runAdb = runAndroidAdb
) {
  const deadline = Date.now() + timeoutMs
  let lastLabels = []
  while (Date.now() < deadline) {
    try {
      const controls = parseHostedAndroidAccessibilityControls(
        await runAdb(
          emulator.adb,
          ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
          Math.min(10_000, Math.max(1_000, deadline - Date.now()))
        )
      )
      lastLabels = controls.map((control) => control.label).filter(Boolean)
      for (const label of labels) {
        const control = controls.find((candidate) => candidate.enabled && candidate.label === label)
        if (control) {
          return { label, point: controlCenter(control) }
        }
      }
    } catch {
      // Android can reject a dump while the activity window is changing.
    }
    await delay(250)
  }
  throw new Error(
    `Android accessibility control was not found: ${labels.join(', ')}. Last labels: ${lastLabels
      .slice(0, 32)
      .join(', ')}`
  )
}

export async function tapHostedAndroidAccessibilityControl(
  emulator,
  label,
  timeoutMs,
  runAdb = runAndroidAdb
) {
  const match = await waitForHostedAndroidAccessibilityControlMatch(
    emulator,
    [label],
    timeoutMs,
    runAdb
  )
  await tapAndroidPixelPoint(emulator, match.point, runAdb)
  return match.point
}

export async function tapHostedAndroidPoint(emulator, point, runAdb = runAndroidAdb) {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    throw new Error('Android normalized tap point is invalid')
  }
  const display = parseHostedAndroidDisplaySize(await runAdb(emulator.adb, ['shell', 'wm', 'size']))
  return tapAndroidPixelPoint(
    emulator,
    {
      x: Math.round(point.x * display.width),
      y: Math.round(point.y * display.height)
    },
    runAdb
  )
}

export function parseHostedAndroidAccessibilityControls(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > ACCESSIBILITY_TREE_MAX_BYTES) {
    throw new Error('Android accessibility response is invalid')
  }
  const controls = []
  for (const match of value.matchAll(/<node\s+([^>]+?)(?:\/>|>)/gu)) {
    const attributes = parseAttributes(match[1])
    const bounds = parseBounds(attributes.bounds)
    const label = decodeXmlAttribute(attributes.text || attributes['content-desc'] || '')
    if (!bounds || (!label && attributes.enabled !== 'true')) {
      continue
    }
    controls.push({
      label,
      enabled: attributes.enabled === 'true',
      bounds
    })
  }
  return controls
}

export function parseHostedAndroidDisplaySize(value) {
  if (typeof value !== 'string') {
    throw new Error('Android display size is invalid')
  }
  const matches = [...value.matchAll(DISPLAY_SIZE_PATTERN)]
  const selected = matches.at(-1)
  const width = Number.parseInt(selected?.[1] ?? '', 10)
  const height = Number.parseInt(selected?.[2] ?? '', 10)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Android display size is invalid')
  }
  return { width, height }
}

function parseAttributes(value) {
  const attributes = {}
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/gu)) {
    attributes[match[1]] = match[2]
  }
  return attributes
}

function parseBounds(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(value ?? '')
  if (!match) {
    return null
  }
  const [left, top, right, bottom] = match.slice(1).map(Number)
  if (right <= left || bottom <= top) {
    return null
  }
  return { left, top, right, bottom }
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function controlCenter(control) {
  return {
    x: Math.round((control.bounds.left + control.bounds.right) / 2),
    y: Math.round((control.bounds.top + control.bounds.bottom) / 2)
  }
}

async function tapAndroidPixelPoint(emulator, point, runAdb) {
  await runAdb(emulator.adb, ['shell', 'input', 'tap', String(point.x), String(point.y)])
  return point
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
