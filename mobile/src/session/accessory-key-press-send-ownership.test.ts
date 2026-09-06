import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const commandDockSource = readFileSync(
  new URL('./MobileSessionCommandDock.tsx', import.meta.url),
  'utf8'
)

function repeatablePressInBlock(): string {
  const start = commandDockSource.indexOf('onPressIn={() => {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = commandDockSource.indexOf('onPressOut={', start)
  expect(end).toBeGreaterThan(start)
  return commandDockSource.slice(start, end)
}

describe('accessory key press send ownership', () => {
  // startAccessoryRepeat's controller sends at press time and then repeats; a second
  // press-time send in the dock emitted every arrow/Backspace/Tab tap twice.
  it('gives the repeat controller sole ownership of the press-time send', () => {
    const block = repeatablePressInBlock()

    expect(block).toContain('startAccessoryRepeat(createTerminalLiveAccessoryInput(key))')
    expect(block).not.toContain('handleAccessoryKey(')
  })

  it('still sends non-repeatable keys once on release', () => {
    expect(commandDockSource).toContain(
      'void handleAccessoryKey(createTerminalLiveAccessoryInput(key))'
    )
  })
})
