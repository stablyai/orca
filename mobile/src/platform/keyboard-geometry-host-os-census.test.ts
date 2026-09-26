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

/** Lines reading `Platform.OS` within two lines of keyboard or inset arithmetic. */
export function platformReadsInGeometry(source: string): number[] {
  const lines = source.split('\n')
  return lines.flatMap((line, index) =>
    line.includes('Platform.OS') &&
    lines.slice(Math.max(0, index - 2), index + 3).some((near) => GEOMETRY.test(near))
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
      platformReadsInGeometry(readFileSync(file, 'utf8')).map(
        (line) => `${relative(MOBILE_DIR, file)}:${line}`
      )
    )
    expect(offenders).toEqual([])
  })
})
