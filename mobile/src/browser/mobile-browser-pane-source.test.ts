import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./MobileBrowserPane.tsx', import.meta.url), 'utf8')

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('MobileBrowserPane source invariants', () => {
  it('mirrors handler refs in a layout effect instead of during render', () => {
    const mirrorBlock = sliceBetween(
      'useLayoutEffect(() => {',
      '  useEffect(() => {\n    lastZoomResetUrlRef.current'
    )

    expect(mirrorBlock).toContain('frameMetadataRef.current = frameMetadata')
    expect(mirrorBlock).toContain('layoutRef.current = layout')
    expect(mirrorBlock).toContain('dialogRef.current = dialog')
    expect(mirrorBlock).toContain('zoomRef.current = zoom')
    expect(mirrorBlock).toContain('}, [dialog, frameMetadata, layout, zoom])')
  })
})
