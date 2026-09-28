/**
 * The shell serves no page older than its floor (`MOBILE_WEB_PAGE_VERSION_FLOOR`), so it keeps no
 * path for one: no negotiated `accepts`/`reports`, and no WebView resized for the keyboard. The
 * retired names are listed so a reintroduction goes red.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const MOBILE_DIR = join(import.meta.dirname, '..', '..')
const SHELL_DIR = import.meta.dirname
const RETIRED = new RegExp(
  [
    'softwareKeyboardWindowInset',
    'viewShortenedBy',
    'pageReadsKeyboardInset',
    'shellPageReadsKeyboardInset',
    'shellKeyboardGeometry',
    'BRIDGE_KEYBOARD_INSET_ACCEPT',
    'BRIDGE_ROUTE_UPDATE_ACCEPT',
    'BRIDGE_SAFE_AREA_ACCEPT',
    'BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT',
    'BRIDGE_SHELL_ACCEPTS',
    'BRIDGE_MAX_PAGE_ACCEPTS',
    'pageReportsPaint',
    'pageOwnsSafeArea',
    'shellPageOwnsSafeArea',
    'shellAccepts',
    'PageReadyDeclaration',
    "'keyboard-inset'",
    "'route-update'",
    "'safe-area-insets'",
    "'page-client-identity'"
  ].join('|')
)
/** The negotiated fields themselves, in code: a `ready` or `init` declaring what it takes or reports. */
const NEGOTIATED_FIELD = /\.(accepts|reports)\b|\b(accepts|reports)\??:/
const COMMENT = /^\s*(\/\/|\*|\/\*)/
const KEYBOARD_SIZES_VIEW = /\b(padding|margin)?(Bottom|bottom|height|Height)\s*:[^,}\n]*keyboard/i

/** Lines that bring back a path for an older page, or size the view from the keyboard. */
export function olderPagePaths(source: string, inShell: boolean): number[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      RETIRED.test(line) ||
      (inShell &&
        ((NEGOTIATED_FIELD.test(line) && !COMMENT.test(line)) || KEYBOARD_SIZES_VIEW.test(line)))
        ? [index + 1]
        : []
    )
}

function sources(dir: string): string[] {
  return censusSourceFiles(dir).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)
  )
}

describe('the shell and a page older than its floor', () => {
  it('finds the lines it is looking for', () => {
    expect(olderPagePaths('style={{ paddingBottom: keyboardInset }}', true)).toEqual([1])
    expect(olderPagePaths("accepts.includes('keyboard-inset')", false)).toEqual([1])
    expect(olderPagePaths('if (accepts.includes(BRIDGE_SAFE_AREA_ACCEPT)) {', false)).toEqual([1])
    expect(olderPagePaths('    accepts: z.array(z.string()).optional(),', true)).toEqual([1])
    expect(olderPagePaths('return message.reports ?? []', true)).toEqual([1])
    expect(olderPagePaths('session.pageOwnsSafeArea', false)).toEqual([1])
    expect(
      olderPagePaths('{ paddingTop: insets.top, paddingBottom: insets.bottom }', true)
    ).toEqual([])
    expect(olderPagePaths('publishKeyboardInset(keyboardInset)', true)).toEqual([])
    // The field rule is the shell's code: elsewhere, and in prose, `accepts` is an ordinary word.
    expect(olderPagePaths('gate.accepts(byteCount)', false)).toEqual([])
    expect(olderPagePaths('    // the answer is what the caller reports: a page', true)).toEqual([])
  })

  it('keeps no path for one anywhere in the app or the page entry', () => {
    const offenders = [
      ...sources(join(MOBILE_DIR, 'src')),
      ...sources(join(MOBILE_DIR, 'web-entry'))
    ].flatMap((file) =>
      olderPagePaths(readFileSync(file, 'utf8'), file.startsWith(SHELL_DIR)).map(
        (line) => `${relative(MOBILE_DIR, file)}:${line}`
      )
    )
    expect(offenders).toEqual([])
  })
})
