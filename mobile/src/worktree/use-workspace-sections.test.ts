import { describe, expect, it } from 'vitest'
import { getSectionCollapsedKeys, isSectionCollapsed } from './use-workspace-sections'
import type { Section } from './workspace-list-types'

describe('isSectionCollapsed', () => {
  it('collapses when s.key is in collapsedGroups', () => {
    const section: Section = { key: 'all', title: 'All', data: [] }
    expect(isSectionCollapsed(section, new Set(['all']))).toBe(true)
    expect(isSectionCollapsed(section, new Set(['other']))).toBe(false)
  })

  it('collapses when s.collapseKey is in collapsedGroups', () => {
    const section: Section = {
      key: 'project:slides-benchmark@local',
      collapseKey: 'project:slides-benchmark',
      title: 'slides-benchmark',
      data: []
    }
    expect(isSectionCollapsed(section, new Set(['project:slides-benchmark']))).toBe(true)
    expect(isSectionCollapsed(section, new Set(['other']))).toBe(false)
  })

  it('collapses a local project section when desktop stored project:repo:id in collapsedGroups', () => {
    const section: Section = {
      key: 'repo:slides-benchmark',
      title: 'slides-benchmark',
      repo: {
        id: 'slides-benchmark',
        displayName: 'slides-benchmark',
        path: '/tmp/slides-benchmark'
      },
      data: []
    }
    expect(isSectionCollapsed(section, new Set(['project:repo:slides-benchmark']))).toBe(true)
    expect(isSectionCollapsed(section, new Set(['repo:slides-benchmark']))).toBe(true)
  })

  it('collapses a project-prefixed section when collapsedGroups has repo:id', () => {
    const section: Section = {
      key: 'project:repo:slides-benchmark',
      title: 'slides-benchmark',
      repo: {
        id: 'slides-benchmark',
        displayName: 'slides-benchmark',
        path: '/tmp/slides-benchmark'
      },
      data: []
    }
    expect(isSectionCollapsed(section, new Set(['repo:slides-benchmark']))).toBe(true)
    expect(isSectionCollapsed(section, new Set(['project:repo:slides-benchmark']))).toBe(true)
  })

  it('returns all matching keys from collapsedGroups via getSectionCollapsedKeys', () => {
    const section: Section = {
      key: 'project:repo:slides-benchmark',
      title: 'slides-benchmark',
      repo: {
        id: 'slides-benchmark',
        displayName: 'slides-benchmark',
        path: '/tmp/slides-benchmark'
      },
      data: []
    }
    expect(
      getSectionCollapsedKeys(
        section,
        new Set(['repo:slides-benchmark', 'project:repo:slides-benchmark', 'unrelated'])
      ).sort()
    ).toEqual(['project:repo:slides-benchmark', 'repo:slides-benchmark'])
  })
})
