import { softwareKeyboardWindowInset } from '../platform/software-keyboard-window-inset'

/** What the shell does with one keyboard reading: the height it hands the page, which is the one
 *  native screens read on this OS, and the strip it takes off the view, none for a page that
 *  reads the height. */
export function shellKeyboardGeometry(input: {
  keyboardHeight: number
  bottomInset: number
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
  pageReadsKeyboardInset: boolean
}): { keyboardInset: number; viewShortenedBy: number } {
  return {
    keyboardInset: Math.max(0, input.keyboardHeight),
    // Legacy: only a page without the `keyboard-inset` accept is shortened; delete this branch (and
    // `softwareKeyboardWindowInset`) once every served page declares it.
    viewShortenedBy: input.pageReadsKeyboardInset ? 0 : softwareKeyboardWindowInset(input)
  }
}
