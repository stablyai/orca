import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const homeSource = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8')

describe('Home host edit navigation wiring', () => {
  it('uses the cold-navigator-safe edit transition', () => {
    expect(homeSource).toMatch(
      /onEdit:\s*\(hostId\)\s*=>\s*navigateToMobileHostEdit\(router,\s*hostId\)/
    )
  })
})
