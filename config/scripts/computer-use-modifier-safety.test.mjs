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
  if (start < 0 || end < 0) {
    throw new Error(`Missing source boundary: ${startMarker} → ${endMarker}`)
  }
  return contents.slice(start, end)
}

describe('computer-use modifier safety', () => {
  it('uses mouse-event flags instead of held modifier keys on macOS', () => {
    const macOS = source('native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift')
    const clickInput = sourceBetween(macOS, 'static func click(', 'static func scroll(')
    const mouseInput = sourceBetween(
      macOS,
      'private static func mouse(',
      'private static func keyEvent('
    )

    expect(mouseInput).toContain('event.flags = flags')
    expect(clickInput.match(/flags: flags/gu)).toHaveLength(3)
    expect(clickInput).not.toContain('down: true')
  })

  it('submits each modified Windows click in a closed, timed SendInput batch', () => {
    const windows = source('native/computer-use-windows/runtime.ps1')
    const modifiedClick = sourceBetween(
      windows,
      'public static void SendModifiedClick',
      'private static INPUT KeyboardInput'
    )
    const mouseClick = sourceBetween(
      windows,
      'function Send-OrcaMouseClick',
      'function Send-OrcaDrag'
    )

    expect(modifiedClick).toContain('SendInput((uint)values.Length, values')
    expect(modifiedClick).toContain('SendInput((uint)releaseValues.Length, releaseValues')
    expect(modifiedClick).toContain('if (sent != (uint)values.Length)')
    expect(modifiedClick).toContain('releases.Add(MouseInput(mouseInput, mouseUp))')
    expect(modifiedClick).not.toContain('int count')
    expect(mouseClick).toMatch(
      /for \(\$i = 0; \$i -lt \$clickCount; \$i\+\+\) \{\s+\[OrcaDesktopWin32\]::SendModifiedClick\(/
    )
    expect(mouseClick).toContain('if ($i + 1 -lt $clickCount) { Start-Sleep -Milliseconds 35 }')
    expect(windows).not.toContain('keybd_event')
  })

  it('keeps Linux modifier release in the xdotool sequence and a fallback', () => {
    const linux = source('native/computer-use-linux/runtime.py')
    const modifiedClick = sourceBetween(linux, 'def modified_click_at(', 'def scroll_at(')

    expect(modifiedClick).toContain('command.extend(["keyup", modifier])')
    expect(modifiedClick).toContain('is_wayland')
    expect(modifiedClick).toContain('modified clicks require xdotool on an X11 session')
    expect(modifiedClick).toContain('finally:')
    expect(modifiedClick).toContain('check=False')
    expect(modifiedClick).toContain('timeout=5')
    expect(modifiedClick).toContain('timeout=2')
  })
})
