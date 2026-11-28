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

it('maps signed and underscore-separated palette indices like Ghostty', () => {
  const parsed = parseGhosttyConfig(
    'palette = -0=#112233\npalette = +5=#223344\npalette = 1_5=#334455\npalette = 0x0_e=#445566\n'
  )
  expect(mapGhosttyToOrca(parsed).diff.terminalColorOverrides).toEqual({
    black: '#112233',
    magenta: '#223344',
    brightWhite: '#334455',
    brightCyan: '#445566'
  })
})

it('does not reinterpret malformed palette indices as valid prefixes', () => {
  const parsed = parseGhosttyConfig(
    'palette = 1=#112233\npalette = 1wrong=#ffffff\npalette = -1=#ffffff\npalette = _1=#ffffff\npalette = 1_=#ffffff\npalette = 0x_1=#ffffff\n'
  )
  expect(mapGhosttyToOrca(parsed).diff.terminalColorOverrides).toEqual({ red: '#112233' })
})
