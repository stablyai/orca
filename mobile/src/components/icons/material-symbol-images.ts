import { useEffect, useState } from 'react'
import type { ImageSourcePropType } from 'react-native'
import { unstable_getMaterialSymbolSourceAsync } from 'expo-symbols'
import { materialSymbol } from './platform-symbol-names'

// Large enough to stay sharp at 24 dp; Compose tints it with the content colour.
const RENDER_SIZE = 72
const images = new Map<string, Promise<ImageSourcePropType | null>>()
const loaded = new Map<string, ImageSourcePropType | null>()

function loadImage(symbol: string): Promise<ImageSourcePropType | null> {
  let pending = images.get(symbol)
  if (!pending) {
    pending = unstable_getMaterialSymbolSourceAsync(materialSymbol(symbol), RENDER_SIZE, '#000000')
      .catch(() => null)
      .then((image) => {
        loaded.set(symbol, image)
        return image
      })
    images.set(symbol, pending)
  }
  return pending
}

/** Compose menus and toolbars take an image, not a font glyph, so each Material Symbol is drawn once. */
export function useMaterialSymbolImages(
  symbols: readonly string[]
): ReadonlyMap<string, ImageSourcePropType | null> {
  const [, setRevision] = useState(0)
  // The key stands in for the array, which callers rebuild every render.
  const key = symbols.join('|')
  const missingAtRender = symbols.some((symbol) => !loaded.has(symbol))
  useEffect(() => {
    const missing = symbols.filter((symbol) => !loaded.has(symbol))
    if (missing.length === 0) {
      // A shared load can settle between render and this effect; render again to pick it up.
      if (missingAtRender) {
        setRevision((revision) => revision + 1)
      }
      return
    }
    let stale = false
    void Promise.all(missing.map(loadImage)).then(() => {
      if (!stale) {
        setRevision((revision) => revision + 1)
      }
    })
    return () => {
      stale = true
    }
  }, [key, missingAtRender])
  return loaded
}
