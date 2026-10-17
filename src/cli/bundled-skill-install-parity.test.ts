import { expect, it } from 'vitest'
import { BUNDLED_ORCA_SKILL_PACKAGES } from '../main/skills/bundled-orca-skill-packages'
import { BUNDLED_SKILL_GUIDES } from './bundled-skill-guides'

// Why: `orca skills install` lists guide names but installs package bytes; a name in one
// table and not the other would be offered and then fail.
it('installs exactly the skills `orca skills install` offers', () => {
  expect(BUNDLED_ORCA_SKILL_PACKAGES.map((entry) => entry.name).toSorted()).toEqual(
    BUNDLED_SKILL_GUIDES.map((guide) => guide.name).toSorted()
  )
})
