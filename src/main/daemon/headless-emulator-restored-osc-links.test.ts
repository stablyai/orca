import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

let emulator: HeadlessEmulator | undefined

const LINK = { row: 0, startCol: 0, endCol: 4, uri: 'https://example.com' }

afterEach(() => {
  emulator?.dispose()
  emulator = undefined
})

describe('HeadlessEmulator restored OSC link ranges', () => {
  it('keeps restored ranges across a resize to the size already applied', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    emulator.setRestoredOscLinks([LINK])

    emulator.resize(80, 24)

    expect(emulator.getSnapshot().oscLinks).toEqual([LINK])
  })

  it('drops restored ranges when the dimensions actually change', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    emulator.setRestoredOscLinks([LINK])

    emulator.resize(100, 24)

    expect(emulator.getSnapshot().oscLinks).toEqual([])
  })

  it('drops restored ranges on a row-count change', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    emulator.setRestoredOscLinks([LINK])

    emulator.resize(80, 40)

    expect(emulator.getSnapshot().oscLinks).toEqual([])
  })

  it('survives a replayed run of same-size resize records', async () => {
    // Match history-reader’s resize-before-record replay order.
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    emulator.setRestoredOscLinks([LINK])

    for (let i = 0; i < 5; i++) {
      emulator.resize(80, 24)
    }

    expect(emulator.getSnapshot().oscLinks).toEqual([LINK])
  })

  it('still drops restored ranges on clearScrollback', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    emulator.setRestoredOscLinks([LINK])

    emulator.clearScrollback()

    expect(emulator.getSnapshot().oscLinks).toEqual([])
  })
})
