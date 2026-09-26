/**
 * Keyboard and inset arithmetic branches on the host OS, never on `Platform.OS`.
 *
 * The page runs as `web` while the keyboard it lifts over is the phone's, reported in that OS's own
 * terms (iOS counts the home indicator). A `Platform.OS === 'ios'` there takes the Android branch on
 * an iPhone page: measured on the iPhone 17 simulator, the terminal lifted 34 pt past native.
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const MOBILE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const GEOMETRY =
  /keyboardHeight|keyboardLift|keyboardInset|bottomInset|insets\.bottom|KeyboardAvoidingView|keyboard(Will|Did)(Show|Hide)/

const KEYBOARD_READ =
  /keyboardHeight|keyboardLift|keyboardInset|useKeyboardOcclusion|useSoftKeyboard/
const KEYBOARD_IMPORT = /from '[^']*(keyboard|inset)[^']*'/i
const KEYBOARD_FILE = /(keyboard|inset|drawer|lift)[^/]*$/i
const COMMENT = /^\s*(\/\/|\*|\/\*)/

/**
 * `Platform.OS` reads near keyboard or inset arithmetic, or anywhere in a file that reads the keyboard,
 * imports a keyboard/inset module or is named for one: a live-input reopen flag four lines from its
 * keyboard height escaped the proximity rule alone. Comments are not reads.
 */
export function platformReadsInGeometry(source: string, file = ''): number[] {
  const lines = source.split('\n')
  const wholeFile =
    KEYBOARD_READ.test(source) || KEYBOARD_IMPORT.test(source) || KEYBOARD_FILE.test(file)
  return lines.flatMap((line, index) =>
    line.includes('Platform.OS') &&
    !COMMENT.test(line) &&
    (wholeFile ||
      lines.slice(Math.max(0, index - 2), index + 3).some((near) => GEOMETRY.test(near)))
      ? [index + 1]
      : []
  )
}

function files(): string[] {
  return ['src', 'app'].flatMap((dir) =>
    censusSourceFiles(fileURLToPath(new URL(`../../${dir}/`, import.meta.url))).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('host-os.ts')
    )
  )
}

describe('keyboard and inset arithmetic', () => {
  it('finds the reads it is looking for', () => {
    expect(
      platformReadsInGeometry("const lift = Platform.OS === 'ios' ? keyboardHeight - 1 : 0")
    ).toEqual([1])
    expect(
      platformReadsInGeometry("keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}")
    ).toEqual([])
  })

  it('reads the host OS, never Platform.OS', () => {
    const offenders = files().flatMap((file) =>
      platformReadsInGeometry(readFileSync(file, 'utf8'), file).map(
        (line) => `${relative(MOBILE_DIR, file)}:${line}`
      )
    )
    expect(offenders).toEqual([])
  })
})
