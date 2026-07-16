/**
 * Issue #8838 guard — pipeline emits real <br> in table cells.
 * Run: pnpm exec node docs/bug-reproductions/scripts/repro-8838-br-in-table.mjs
 * (vitest file intentionally minimal; full render is in the .mjs script)
 */
import { describe, expect, it } from 'vitest'
import { defaultSchema } from 'rehype-sanitize'

describe('issue #8838 br allowed in sanitize schema', () => {
  it('defaultSchema includes br', () => {
    expect(defaultSchema.tagNames ?? []).toContain('br')
  })
})
