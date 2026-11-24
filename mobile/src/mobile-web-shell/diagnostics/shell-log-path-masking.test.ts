import { describe, expect, it } from 'vitest'
import { maskUserText } from './shell-log-path-masking'

describe('shell log path masking', () => {
  it('masks absolute paths wherever they start, including spaced and Windows ones', () => {
    expect(maskUserText("open '/var/mobile/Containers/a.db' failed")).toBe("open '[path]' failed")
    expect(maskUserText('at f (/Users/me/secret.js:1)')).toBe('at f ([path])')
    expect(maskUserText('bad `/Users/me/x.js` here')).toBe('bad `[path]` here')
    expect(maskUserText('path="/home/bob/x" [/Users/bob/y]')).toBe('path="[path]" [[path]]')
    expect(maskUserText('read C:\\Users\\bob\\x.txt and \\\\srv\\share\\y')).toBe(
      'read [path] and [path]'
    )
    expect(maskUserText('key:~/notes.txt')).toBe('key:[path]')
    expect(maskUserText('open C:\\Users\\John Doe\\proj\\x.ts failed')).toBe('open [path] failed')
    expect(maskUserText('at /Users/Jane Q/My Proj/a.js and more')).toBe('at [path] and more')
    expect(maskUserText('a,/Users/x/y')).toBe('a,[path]')
    expect(maskUserText('Cannot read properties of undefined')).toBe(
      'Cannot read properties of undefined'
    )
  })
})
