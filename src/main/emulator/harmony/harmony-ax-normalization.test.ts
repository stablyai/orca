import { describe, expect, it } from 'vitest'
import { normalizeHarmonyAxTree, parseBounds } from './harmony-ax-normalization'

const tree = {
  attributes: { type: 'PhoneWindow', bounds: '[0,0][1280,2832]', description: 'Home' },
  children: [
    {
      attributes: { type: 'Text', bounds: '[100,200][500,300]', text: 'Hello', id: 'hello_id' },
      children: []
    },
    {
      attributes: {
        type: 'Button',
        bounds: '[0,0][128,100]',
        description: 'OK',
        enabled: 'false'
      },
      children: []
    }
  ]
}

describe('parseBounds', () => {
  it('parses two coordinate pairs into a frame', () => {
    expect(parseBounds('[10,20][110,220]')).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('handles negative coordinates', () => {
    expect(parseBounds('[-5,-10][5,10]')).toEqual({ x: -5, y: -10, width: 10, height: 20 })
  })

  it('returns null for malformed bounds', () => {
    expect(parseBounds('nonsense')).toBeNull()
  })
})

describe('normalizeHarmonyAxTree', () => {
  it('normalizes frames to 0..1 and maps roles/labels', () => {
    const [root] = normalizeHarmonyAxTree(tree)
    expect(root).toMatchObject({
      role: 'Home',
      type: 'PhoneWindow',
      frame: { x: 0, y: 0, width: 1, height: 1 }
    })

    const [text, button] = root.children
    expect(text).toMatchObject({
      role: 'Text',
      label: 'Hello',
      value: 'Hello',
      id: 'hello_id',
      enabled: true,
      frame: { x: 0.0781, y: 0.0706, width: 0.3125, height: 0.0353 }
    })
    expect(button).toMatchObject({
      role: 'OK',
      label: 'OK',
      value: '',
      enabled: false,
      frame: { x: 0, y: 0, width: 0.1, height: 0.0353 }
    })
  })

  it('normalizes frames relative to the root screen origin', () => {
    const tree = {
      attributes: { type: 'Column', bounds: '[10,20][110,220]' },
      children: [
        {
          attributes: { type: 'Text', bounds: '[10,20][60,120]' },
          children: []
        }
      ]
    }
    const [root] = normalizeHarmonyAxTree(tree)
    expect(root.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(root.children[0]?.frame).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 })
  })

  it('returns [] when the root itself has no bounds', () => {
    expect(normalizeHarmonyAxTree({ attributes: { type: 'X' }, children: [] })).toEqual([])
  })

  it('returns [] for a zero-size screen', () => {
    expect(normalizeHarmonyAxTree({ attributes: { bounds: '[0,0][0,0]' }, children: [] })).toEqual(
      []
    )
  })
})
