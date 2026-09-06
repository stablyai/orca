import { describe, expect, it } from 'vitest'
import {
  alignHostedIosSessionPoint,
  alignHostedIosTerminalLinkPoints
} from '../../scripts/hosted-ios-adversarial-terminal-links.mjs'

describe('hosted iOS terminal link point alignment', () => {
  it('removes the transient viewport displacement before a native tap', () => {
    expect(
      alignHostedIosTerminalLinkPoints(
        {
          file: { x: 0.07, y: 0.72 },
          http: { x: 0.07, y: 0.79 },
          javascript: { x: 0.07, y: 0.65 }
        },
        { x: 0.4, y: 0.5 },
        { x: 0.4, y: 0.14 }
      )
    ).toEqual({
      points: {
        file: { x: 0.07, y: 0.36 },
        http: { x: 0.07, y: 0.43000000000000005 },
        javascript: { x: 0.07, y: 0.29000000000000004 }
      },
      yOffset: -0.36
    })
  })

  it('rejects an alignment that leaves the native screen', () => {
    expect(() =>
      alignHostedIosTerminalLinkPoints(
        { file: { x: 0.2, y: 0.1 } },
        { x: 0.2, y: 0.8 },
        { x: 0.2, y: 0.1 }
      )
    ).toThrow('alignment is invalid')
  })

  it('applies the measured offset only to Session-origin taps', () => {
    const point = { x: 0.8, y: 0.7 }
    expect(
      alignHostedIosSessionPoint(point, -0.36, { href: 'orca://host/session/opaque' })
    ).toEqual({ x: 0.8, y: 0.33999999999999997 })
    expect(
      alignHostedIosSessionPoint(point, -0.36, { href: 'orca://host/source-control/opaque' })
    ).toBe(point)
  })
})
