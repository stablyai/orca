import { describe, expect, it } from 'vitest'
import { normalizeServeSimAxTree } from './serve-sim-ax-normalization'

describe('normalizeServeSimAxTree', () => {
  it('normalizes frames to 0..1 over the first root screen frame and nests children', () => {
    const raw = [
      {
        type: 'Application',
        role_description: 'application',
        AXLabel: 'Demo',
        AXValue: '',
        AXUniqueId: null,
        enabled: true,
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          {
            type: 'Button',
            role_description: 'button',
            AXLabel: 'Continue',
            AXValue: 'go',
            AXUniqueId: 'btn-1',
            enabled: true,
            frame: { x: 100, y: 400, width: 200, height: 50 },
            children: []
          }
        ]
      }
    ]

    expect(normalizeServeSimAxTree(raw)).toEqual([
      {
        role: 'application',
        type: 'Application',
        label: 'Demo',
        value: '',
        enabled: true,
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: 'button',
            type: 'Button',
            label: 'Continue',
            value: 'go',
            enabled: true,
            id: 'btn-1',
            frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
            children: []
          }
        ]
      }
    ])
  })

  it('normalizes relative to a screen frame with a non-zero origin', () => {
    const raw = [
      {
        type: 'Window',
        frame: { x: 10, y: 20, width: 200, height: 400 },
        children: [
          { type: 'Cell', frame: { x: 60, y: 120, width: 100, height: 100 }, children: [] }
        ]
      }
    ]

    const [root] = normalizeServeSimAxTree(raw)
    expect(root.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(root.children[0]!.frame).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.25 })
  })

  it('marks a disabled element and defaults missing text fields to empty strings', () => {
    const raw = [
      {
        type: 'StaticText',
        enabled: false,
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: []
      }
    ]

    expect(normalizeServeSimAxTree(raw)[0]).toMatchObject({
      role: '',
      type: 'StaticText',
      label: '',
      value: '',
      enabled: false
    })
  })

  it('caps the tree at 500 nodes and marks the parent whose children were cut', () => {
    const child = (label: string) => ({
      type: 'StaticText',
      AXLabel: label,
      frame: { x: 0, y: 0, width: 10, height: 10 },
      children: []
    })
    const raw = [
      {
        type: 'Application',
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: Array.from({ length: 600 }, (_, i) => child(`row-${i}`))
      }
    ]

    const [root] = normalizeServeSimAxTree(raw)
    // Root consumes one slot of the 500-node budget.
    expect(root.children).toHaveLength(499)
    expect(root.truncated).toBe(true)
    expect(root.children[0]!.truncated).toBeUndefined()
  })

  it('falls back to a unit screen for malformed roots instead of dividing by zero', () => {
    const raw = [{ type: 'Application', children: [] }]
    expect(normalizeServeSimAxTree(raw)).toEqual([
      {
        role: '',
        type: 'Application',
        label: '',
        value: '',
        enabled: true,
        frame: { x: 0, y: 0, width: 0, height: 0 },
        children: []
      }
    ])
    expect(normalizeServeSimAxTree([])).toEqual([])
  })
})
