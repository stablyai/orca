import { extractMouseModeScanTail } from './write-queue'
import { scope } from './document-scope'

export function isAltScreenActive(data: unknown): data is string {
  if (typeof data !== 'string') {
    return false
  }
  const on = data.lastIndexOf(scope.ESC + '[?1049h')
  const off = data.lastIndexOf(scope.ESC + '[?1049l')
  return on !== -1 && on > off
}

export function normalizeInitialData(data: unknown) {
  if (!isAltScreenActive(data)) {
    return data
  }
  const on = data.lastIndexOf(scope.ESC + '[?1049h')
  // Why: SerializeAddon can include normal-buffer scrollback before the
  // active alternate-screen snapshot. Replaying both into a fresh mobile
  // xterm duplicates TUI frames and can flatten SGR attributes.
  return on > 0 ? data.slice(on) : data
}

export function updateMouseModeFromData(data: unknown) {
  if (typeof data !== 'string' || data.length === 0) {
    return
  }
  const input = scope.mouseModeScanTail + data
  scope.mouseModeScanTail = extractMouseModeScanTail(input)
  const re = new RegExp(
    scope.ESC + 'c|' + scope.ESC + '\\[\\?([0-9;]+)([hl])|' + scope.C1_CSI + '\\?([0-9;]+)([hl])',
    'g'
  )
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    if (match[0] === scope.ESC + 'c') {
      scope.trackedMouseTrackingMode = 'none'
      scope.sgrMouseMode = false
      scope.sgrMousePixelsMode = false
      continue
    }
    const enabled = (match[2] || match[4]) === 'h'
    const params = (match[1] || match[3]).split(';')
    for (let i = 0; i < params.length; i++) {
      if (params[i] === '') {
        continue
      }
      const param = Number(params[i])
      if (!Number.isInteger(param)) {
        continue
      }
      if (param === 9) {
        scope.trackedMouseTrackingMode = enabled ? 'x10' : 'none'
      }
      if (param === 1000) {
        scope.trackedMouseTrackingMode = enabled ? 'vt200' : 'none'
      }
      if (param === 1002) {
        scope.trackedMouseTrackingMode = enabled ? 'drag' : 'none'
      }
      if (param === 1003) {
        scope.trackedMouseTrackingMode = enabled ? 'any' : 'none'
      }
      if (param === 1006) {
        scope.sgrMouseMode = enabled
        scope.sgrMousePixelsMode = false
      }
      if (param === 1016) {
        scope.sgrMouseMode = false
        scope.sgrMousePixelsMode = enabled
      }
    }
  }
}
