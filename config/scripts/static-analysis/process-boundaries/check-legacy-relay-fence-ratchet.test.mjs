import { describe, expect, it } from 'vitest'
import { importsLegacyFolder } from './check-legacy-relay-fence-ratchet.mjs'

describe('importsLegacyFolder', () => {
  it('matches a relative import that lands in the legacy relay folder', () => {
    expect(
      importsLegacyFolder('src/main/ipc/x.ts', '../ssh/legacy-relay/legacy-relay-client')
    ).toBe(true)
    expect(importsLegacyFolder('src/main/ssh/x.ts', './legacy-relay/legacy-relay-client')).toBe(
      true
    )
    expect(
      importsLegacyFolder(
        'tests/e2e/a.spec.ts',
        '../../src/main/ssh/legacy-relay/legacy-relay-client'
      )
    ).toBe(true)
  })

  it('ignores lookalike folders, dot segments that leave it, and package imports', () => {
    expect(importsLegacyFolder('src/main/ssh/x.ts', './legacy-relay-tools/a')).toBe(false)
    expect(importsLegacyFolder('src/main/ssh/x.ts', './legacy-relay/../ssh-connection')).toBe(false)
    expect(importsLegacyFolder('src/main/ssh/x.ts', 'legacy-relay/a')).toBe(false)
  })

  it('normalizes Windows separators', () => {
    expect(importsLegacyFolder('src/main/ssh/x.ts', '.\\legacy-relay\\legacy-relay-client')).toBe(
      true
    )
  })
})
