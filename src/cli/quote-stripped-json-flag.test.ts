import { describe, expect, it } from 'vitest'

import { describeQuoteStrippedJsonFlag } from './quote-stripped-json-flag'

describe('quote-stripped JSON flag detection', () => {
  it('explains the likely cause without echoing the value', () => {
    const message = describeQuoteStrippedJsonFlag('payload', '{secret:hunter2}')
    expect(message).toContain('--payload is not valid JSON')
    expect(message).toContain('PowerShell 5.1')
    expect(message).toContain('$v')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('secret')
    expect(describeQuoteStrippedJsonFlag('options', '["a","b"]')).toBeNull()
  })
})
