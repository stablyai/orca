import { expect, it } from 'vitest'
import { mapGhosttyToOrca } from './mapper'
import { parseGhosttyConfig } from './parser'

it('maps radix-prefixed palette indices to their intended ANSI slots', () => {
  const parsed = parseGhosttyConfig(
    'palette = 0x1=#112233\npalette = 0b10=#223344\npalette = 0o3=#334455\npalette = 4=#445566\n'
  )
  expect(mapGhosttyToOrca(parsed).diff.terminalColorOverrides).toEqual({
    red: '#112233',
    green: '#223344',
    yellow: '#334455',
    blue: '#445566'
  })
})

it('does not reinterpret malformed palette indices as valid prefixes', () => {
  const parsed = parseGhosttyConfig('palette = 1=#112233\npalette = 1wrong=#ffffff\n')
  expect(mapGhosttyToOrca(parsed).diff.terminalColorOverrides).toEqual({ red: '#112233' })
})
