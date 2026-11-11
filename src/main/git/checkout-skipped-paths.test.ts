import { describe, expect, it } from 'vitest'
import { parseCheckoutSkippedPaths } from './checkout-skipped-paths'

describe('parseCheckoutSkippedPaths', () => {
  it('reads every path git could not replace, apostrophes included', () => {
    const stderr = [
      "warning: unable to unlink 'public/logo.png': Permission denied",
      "error: unable to unlink old ''draft.txt': Invalid argument",
      "warning: unable to unlink 'it's.md': Permission denied",
      "Switched to branch 'feature'"
    ].join('\n')

    expect(parseCheckoutSkippedPaths(stderr)).toEqual(['public/logo.png', "'draft.txt", "it's.md"])
  })
})
