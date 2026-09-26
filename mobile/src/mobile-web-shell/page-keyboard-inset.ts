import { softwareKeyboardWindowInset } from '../platform/software-keyboard-window-inset'

/**
 * The keyboard height the page is handed: its height above the bottom safe-area inset, which is
 * what Android reports and what the page's non-iOS code reads. iOS measures from the window's
 * bottom, home indicator included, and the page runs as `web`, so the strip comes off here.
 */
export function pageKeyboardInset(input: {
  keyboardHeight: number
  bottomInset: number
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  return input.platform === 'ios'
    ? Math.max(0, keyboardHeight - Math.max(0, input.bottomInset))
    : keyboardHeight
}

/** What the shell does with one keyboard reading: the height it hands the page, and the strip it
 *  takes off the view, which is none for a page that reads the height. */
export function shellKeyboardGeometry(input: {
  keyboardHeight: number
  bottomInset: number
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
  pageReadsKeyboardInset: boolean
}): { keyboardInset: number; viewShortenedBy: number } {
  return {
    keyboardInset: pageKeyboardInset(input),
    // Legacy: only a page without the `keyboard-inset` accept is shortened; delete this branch (and
    // `softwareKeyboardWindowInset`) once every served page declares it.
    viewShortenedBy: input.pageReadsKeyboardInset ? 0 : softwareKeyboardWindowInset(input)
  }
}
