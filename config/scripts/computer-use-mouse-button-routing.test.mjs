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

describe('computer-use mouse button routing', () => {
  it('maps the macOS middle button onto the otherMouse event family', () => {
    const macOS = source('native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift')
    const mapping = sourceBetween(
      macOS,
      'extension MouseButtonSelection {',
      'private func mouseButton('
    )

    expect(mapping).toContain('return .center')
    expect(mapping).toContain('return .otherMouseDown')
    expect(mapping).toContain('return .otherMouseUp')
    // A middle press posted as a left event type would silently left-click.
    expect(mapping).not.toContain('case .middle:\n            return .leftMouseDown')
  })

  it('validates the macOS mouse button before any accessibility shortcut runs', () => {
    const macOS = source('native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift')
    const click = sourceBetween(
      macOS,
      'private func click(params:',
      'private func performClickAction('
    )

    expect(click).toContain('let button = try mouseButton(params["mouseButton"]?.string)')
    expect(click).toContain('button.hasAccessibilityAction')
    // An unvalidated raw string reaches AXPress and reports a left click as success.
    expect(click).not.toContain('params["mouseButton"]?.string ?? "left"')
  })

  it('keeps every platform from resolving a middle click through its accessibility path', () => {
    const windows = source('native/computer-use-windows/runtime.ps1')
    const windowsClick = sourceBetween(
      windows,
      '$handledByPattern = $false',
      'if (-not $handledByPattern)'
    )

    expect(windowsClick).toContain('$Operation.mouse_button -ne "middle"')

    const linux = source('native/computer-use-linux/runtime.py')
    const linuxClick = sourceBetween(linux, 'has_modifiers = bool(', 'if not handled:')

    expect(linuxClick).toContain('operation.get("mouse_button", "left") == "left"')
  })
})
