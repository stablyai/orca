import { describe, expect, it } from 'vitest'
import { validateHudPage } from './hud-page-validator'
import { buildHudPage } from './hud-page-spec'
import type { HudContainerSpec, HudPageBuild } from '../glasses/glasses-bridge'

function textContainer(overrides: Partial<HudContainerSpec> = {}): HudContainerSpec {
  return {
    kind: 'text',
    id: 1,
    name: 'a',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    content: 'hi',
    isEventCapture: 0,
    ...overrides
  } as HudContainerSpec
}

describe('validateHudPage', () => {
  it('passes the standard text layout produced by buildHudPage', () => {
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    expect(validateHudPage(page)).toEqual([])
  })

  it('passes the standard list layout produced by buildHudPage', () => {
    const page = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'b'], footer: 'F' })
    expect(validateHudPage(page)).toEqual([])
  })

  it('flags too-many-containers over 8', () => {
    const containers = Array.from({ length: 9 }, (_, i) =>
      textContainer({ id: i, name: `n${i}`, isEventCapture: i === 0 ? 1 : 0 })
    )
    const page: HudPageBuild = { containers }
    const violations = validateHudPage(page)
    expect(violations).toContainEqual({ code: 'too-many-containers', count: 9 })
  })

  it('flags event-capture-count when not exactly 1', () => {
    const page: HudPageBuild = {
      containers: [
        textContainer({ id: 1, name: 'a', isEventCapture: 1 }),
        textContainer({ id: 2, name: 'b', isEventCapture: 1 })
      ]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'event-capture-count', count: 2 })
  })

  it('flags event-capture-count when zero', () => {
    const page: HudPageBuild = { containers: [textContainer({ isEventCapture: 0 })] }
    expect(validateHudPage(page)).toContainEqual({ code: 'event-capture-count', count: 0 })
  })

  it('flags duplicate-container-id', () => {
    const page: HudPageBuild = {
      containers: [
        textContainer({ id: 1, name: 'a', isEventCapture: 1 }),
        textContainer({ id: 1, name: 'b', isEventCapture: 0 })
      ]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'duplicate-container-id', value: '1' })
  })

  it('flags duplicate-container-name', () => {
    const page: HudPageBuild = {
      containers: [
        textContainer({ id: 1, name: 'dup', isEventCapture: 1 }),
        textContainer({ id: 2, name: 'dup', isEventCapture: 0 })
      ]
    }
    expect(validateHudPage(page)).toContainEqual({
      code: 'duplicate-container-name',
      value: 'dup'
    })
  })

  it('flags container-name-too-long', () => {
    const page: HudPageBuild = {
      containers: [textContainer({ name: 'a'.repeat(17), isEventCapture: 1 })]
    }
    expect(validateHudPage(page)).toContainEqual({
      code: 'container-name-too-long',
      name: 'a'.repeat(17)
    })
  })

  it('flags text-too-long', () => {
    const page: HudPageBuild = {
      containers: [textContainer({ content: 'x'.repeat(1001), isEventCapture: 1 })]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'text-too-long', id: 1, length: 1001 })
  })

  it('flags list-item-limit for too many items', () => {
    const page: HudPageBuild = {
      containers: [
        {
          kind: 'list',
          id: 1,
          name: 'list',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          items: Array.from({ length: 21 }, (_, i) => `item${i}`),
          isEventCapture: 1,
          showSelectionBorder: true
        }
      ]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'list-item-limit', id: 1, count: 21 })
  })

  it('flags list-item-limit for an over-length item', () => {
    const page: HudPageBuild = {
      containers: [
        {
          kind: 'list',
          id: 1,
          name: 'list',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          items: ['x'.repeat(65)],
          isEventCapture: 1,
          showSelectionBorder: true
        }
      ]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'list-item-limit', id: 1, count: 1 })
  })

  it('flags geometry-out-of-bounds', () => {
    const page: HudPageBuild = {
      containers: [textContainer({ x: 500, width: 200, isEventCapture: 1 })]
    }
    expect(validateHudPage(page)).toContainEqual({ code: 'geometry-out-of-bounds', id: 1 })
  })

  it('flags geometry-out-of-bounds for negative origin', () => {
    const page: HudPageBuild = { containers: [textContainer({ y: -1, isEventCapture: 1 })] }
    expect(validateHudPage(page)).toContainEqual({ code: 'geometry-out-of-bounds', id: 1 })
  })
})
