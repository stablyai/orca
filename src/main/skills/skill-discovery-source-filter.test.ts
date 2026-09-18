import { describe, expect, it } from 'vitest'
import type { SkillScanRoot } from './skill-discovery-sources'
import { rootMayContainSourceKind } from './skill-discovery-source-filter'

const homeRoot: SkillScanRoot = {
  id: 'home',
  owner: 'agents',
  path: '/home/alice/.agents/skills',
  label: 'Home',
  sourceKind: 'home',
  providers: ['agent-skills']
}

describe('rootMayContainSourceKind', () => {
  it('treats an empty list as no filter', () => {
    expect(rootMayContainSourceKind(homeRoot, undefined)).toBe(true)
    expect(rootMayContainSourceKind(homeRoot, [])).toBe(true)
  })

  it('keeps home roots for bundled classification', () => {
    expect(rootMayContainSourceKind(homeRoot, ['bundled'])).toBe(true)
    expect(rootMayContainSourceKind(homeRoot, ['plugin'])).toBe(false)
  })
})
