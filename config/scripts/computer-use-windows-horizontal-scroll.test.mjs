import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')

function source(path) {
  return readFileSync(join(projectDir, path), 'utf8')
}

function sourceBetween(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker)
  const end = contents.indexOf(endMarker, start + startMarker.length)
  if (start === -1 || end === -1) {
    throw new Error(`Missing source boundary: ${startMarker} → ${endMarker}`)
  }
  return contents.slice(start, end)
}

describe('Windows computer-use horizontal scroll', () => {
  it('routes left and right through the horizontal wheel with native signs', () => {
    const windows = source('native/computer-use-windows/runtime.ps1')
    const mouseEvents = sourceBetween(windows, '$MouseEvents = @{', 'function Write-OrcaJson')
    const scroll = sourceBetween(windows, '        "scroll" {', '        "drag" {')
    const left = sourceBetween(
      scroll,
      '} elseif ($Operation.direction -eq "left") {',
      '} elseif ($Operation.direction -eq "right") {'
    )
    const right = sourceBetween(
      scroll,
      '} elseif ($Operation.direction -eq "right") {',
      '} elseif ($Operation.direction -ne "up") {'
    )

    expect(mouseEvents).toContain('HorizontalWheel = 0x01000')
    expect(scroll).toContain('$mouseEvent = $MouseEvents.Wheel')
    expect(left).toContain('$mouseEvent = $MouseEvents.HorizontalWheel')
    expect(left).toContain('$delta = -1 * $delta')
    expect(right).toContain('$mouseEvent = $MouseEvents.HorizontalWheel')
    expect(right).not.toContain('$delta = -1 * $delta')
    expect(scroll).toContain(
      '[OrcaDesktopWin32]::mouse_event($mouseEvent, 0, 0, $delta, [UIntPtr]::Zero)'
    )
    expect(scroll).not.toContain('mouse_event($MouseEvents.Wheel')
    expect(scroll).toContain('throw "unsupported scroll direction: $($Operation.direction)"')
  })
})
