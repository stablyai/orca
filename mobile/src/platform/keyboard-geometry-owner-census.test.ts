/**
 * Who may ask React Native's `Keyboard` for geometry: the keyboard seam, and one named exception.
 *
 * react-native-web's `Keyboard` has no `metrics` and an `addListener` that never fires, so a page
 * screen that asks it directly either throws (a fill sheet crashed the page on `metrics()`) or waits
 * forever. The seam has a web sibling that answers from the window instead; everything else reads it.
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const MOBILE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url))

const SEAM = 'src/platform/keyboard-occlusion.ts'
/** A one-shot "open after the keyboard hides" with a timer fallback; it subscribes only while the
 *  seam reports a keyboard, which on the page is never, so there it cannot wait forever. */
const TAB_SHEET_AFTER_HIDE = 'src/session/use-mobile-session-terminal-send-actions.ts'

const asksKeyboard = (line: string): boolean =>
  line.includes('Keyboard.metrics(') || line.includes('Keyboard.addListener(')

function callers(): string[] {
  return censusSourceFiles(SRC_DIR)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => readFileSync(file, 'utf8').split('\n').some(asksKeyboard))
    .map((file) => relative(MOBILE_DIR, file))
    .sort()
}

describe("React Native's Keyboard geometry", () => {
  it('is read only by the keyboard seam and the tab sheet that waits for a hide', () => {
    // Also the presence precondition: the seam itself must match, or the matcher is broken.
    expect(callers()).toEqual([SEAM, TAB_SHEET_AFTER_HIDE].sort())
  })
})
