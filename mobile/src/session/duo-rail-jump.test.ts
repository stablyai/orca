import { describe, expect, it } from 'vitest'
import {
  DUO_RAIL_CONTROL_SIZE,
  duoRailBackFrame,
  duoRailJumpFrames
} from '../layout/duo-status-row'
import { getSideRailStrip } from '../layout/side-rail-strip'
import { spacing } from '../theme/mobile-theme'
import { duoRailJumpPlacement } from './duo-rail-jump'

const COVER = {
  windowWidth: 466,
  windowHeight: 678,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [
    { x: 399.67, y: 29.33, width: 37, height: 37 },
    { x: 382, y: 0, width: 84, height: 174 }
  ]
}

const INNER = {
  windowWidth: 951,
  windowHeight: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }]
}

const KEYBOARD_DOWN_COMPOSER = 560
const KEYBOARD_UP_COMPOSER = 280
const TALL_COMPOSER = 470

function columnOf(scene: typeof COVER) {
  return scene.occlusions.find((region) => region.width >= 80)!
}

function place(scene: typeof COVER, composerTop: number, keyboardInset = 0) {
  const strip = getSideRailStrip(scene)
  return duoRailJumpPlacement({
    chatVisible: true,
    expanded: false,
    strip,
    keyboardInset,
    composerTop,
    windowWidth: scene.windowWidth,
    windowHeight: scene.windowHeight,
    occlusions: scene.occlusions
  })
}

describe('Duo rail jump placement', () => {
  it('keeps both arrows above the composer and below the back button', () => {
    const strip = getSideRailStrip(COVER)
    const column = columnOf(COVER)
    const back = duoRailBackFrame({ ...COVER, strip: strip! })
    const frames = duoRailJumpFrames({
      ...COVER,
      strip: strip!,
      composerTop: KEYBOARD_DOWN_COMPOSER,
      keyboardUp: false
    })
    expect(frames).not.toBeNull()
    expect(frames!.latest.top + frames!.latest.size).toBeLessThanOrEqual(
      KEYBOARD_DOWN_COMPOSER - spacing.sm
    )
    expect(frames!.previous.top).toBe(frames!.latest.top - spacing.sm - DUO_RAIL_CONTROL_SIZE)
    expect(frames!.previous.top).toBeGreaterThanOrEqual(back.top + back.size + spacing.sm)
    expect(frames!.latest.left).toBe(back.left)
    expect(frames!.latest.size).toBe(DUO_RAIL_CONTROL_SIZE)
    expect(frames!.latest.left).toBeGreaterThanOrEqual(column.x)
    expect(frames!.latest.left + frames!.latest.size).toBeLessThanOrEqual(column.x + column.width)
  })

  it('lifts the arrows with the keyboard and with a taller composer', () => {
    const strip = getSideRailStrip(COVER)!
    const down = duoRailJumpFrames({
      ...COVER,
      strip,
      composerTop: KEYBOARD_DOWN_COMPOSER,
      keyboardUp: false
    })
    const up = duoRailJumpFrames({
      ...COVER,
      strip,
      composerTop: KEYBOARD_UP_COMPOSER,
      keyboardUp: true
    })
    const tall = duoRailJumpFrames({
      ...COVER,
      strip,
      composerTop: TALL_COMPOSER,
      keyboardUp: false
    })
    expect(up).not.toBeNull()
    expect(tall).not.toBeNull()
    expect(up!.latest.top).toBeLessThan(down!.latest.top)
    expect(tall!.latest.top).toBeLessThan(down!.latest.top)
    expect(up!.latest.top + up!.latest.size).toBeLessThanOrEqual(KEYBOARD_UP_COMPOSER - spacing.sm)
    expect(tall!.latest.top + tall!.latest.size).toBeLessThanOrEqual(TALL_COMPOSER - spacing.sm)
    expect(up!.previous.top).toBeGreaterThanOrEqual(
      COVER.occlusions[1]!.y + COVER.occlusions[1]!.height
    )
  })

  it('stays in the rail while the keyboard is up, and leaves it when chat expands', () => {
    expect(place(COVER, KEYBOARD_UP_COMPOSER, 312)).not.toBeNull()
    expect(place(COVER, KEYBOARD_DOWN_COMPOSER, 0)).not.toBeNull()
    expect(place(INNER, 520, 0)).not.toBeNull()
    const strip = getSideRailStrip(COVER)
    expect(
      duoRailJumpPlacement({
        chatVisible: true,
        expanded: true,
        strip,
        keyboardInset: 312,
        composerTop: KEYBOARD_UP_COMPOSER,
        windowWidth: COVER.windowWidth,
        windowHeight: COVER.windowHeight,
        occlusions: COVER.occlusions
      })
    ).toBeNull()
    expect(
      duoRailJumpPlacement({
        chatVisible: false,
        expanded: false,
        strip,
        keyboardInset: 0,
        composerTop: KEYBOARD_DOWN_COMPOSER,
        windowWidth: COVER.windowWidth,
        windowHeight: COVER.windowHeight,
        occlusions: COVER.occlusions
      })
    ).toBeNull()
  })

  it('keeps in-transcript placement when the turned column cannot clear the back button', () => {
    const occlusion = { x: 0, y: 545, width: 84, height: 124 }
    const turned = {
      windowWidth: 951,
      windowHeight: 669,
      insets: { top: 0, right: 0, bottom: 34, left: 84 },
      occlusions: [occlusion]
    }
    const strip = getSideRailStrip(turned)
    expect(
      duoRailJumpFrames({
        ...turned,
        strip: strip!,
        composerTop: 560,
        keyboardUp: false
      })
    ).toBeNull()
  })
})
