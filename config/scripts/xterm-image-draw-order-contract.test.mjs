import { afterEach, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  PNG,
  render,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

for (const [virtualId, physicalId] of [
  [9, 2],
  [2, 9]
]) {
  it(`orders overlapping physical ${physicalId} and placeholder ${virtualId} images by protocol ID at equal z`, async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, `a=T,f=100,i=${virtualId},U=1,c=2,r=1,q=2`, PNG)
      await write(h.terminal, `\x1b[H${placeholderCells(virtualId, 0, 2, 1)}`)
      const virtual = h.bitmaps[0]
      await write(h.terminal, '\x1b[H')
      await writeKitty(h.terminal, `a=T,f=100,i=${physicalId},C=1,z=0,q=2`, PNG)
      const physical = h.bitmaps[1]
      const sources = render(h).map((call) => call[0])
      expect(sources).toHaveLength(2)
      expect(sources[0]).toBe(virtualId < physicalId ? virtual : physical)
      expect(sources[1]).toBe(virtualId < physicalId ? physical : virtual)
    } finally {
      h.terminal.dispose()
    }
  })
}
