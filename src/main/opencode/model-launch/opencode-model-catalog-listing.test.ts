import { describe, expect, it } from 'vitest'
import { parseOpenCodeModelListing } from './opencode-model-catalog-listing'

describe('parseOpenCodeModelListing', () => {
  it("reads MiMo Code's IDs, which carry a context-window note", () => {
    const stdout = [
      'xiaomi/mimo-v2.6-flash — window 1.05M, compacts at 944K',
      '{',
      '  "id": "mimo-v2.6-flash",',
      '  "name": "MiMo-V2.6-Flash",',
      '  "variants": {}',
      '}',
      'xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K',
      '{',
      '  "name": "MiMo-V2.6-Pro",',
      '  "variants": {}',
      '}'
    ].join('\n')

    expect(parseOpenCodeModelListing(stdout).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'xiaomi/mimo-v2.6-flash', label: 'xiaomi/MiMo-V2.6-Flash' },
      { id: 'xiaomi/mimo-v2.6-pro', label: 'xiaomi/MiMo-V2.6-Pro' }
    ])
  })
})
