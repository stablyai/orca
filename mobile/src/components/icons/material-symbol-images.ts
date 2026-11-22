import { useEffect, useState } from 'react'
import type { ImageSourcePropType } from 'react-native'
import { unstable_getMaterialSymbolSourceAsync, type AndroidSymbol } from 'expo-symbols'

// Large enough to stay sharp at 24 dp; Compose tints it with the content colour.
const RENDER_SIZE = 72
const images = new Map<string, Promise<ImageSourcePropType | null>>()
const loaded = new Map<string, ImageSourcePropType | null>()

function loadImage(symbol: string): Promise<ImageSourcePropType | null> {
  let pending = images.get(symbol)
  if (!pending) {
    pending = unstable_getMaterialSymbolSourceAsync(symbol as AndroidSymbol, RENDER_SIZE, '#000000')
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
  useEffect(() => {
    const missing = symbols.filter((symbol) => !loaded.has(symbol))
    if (missing.length === 0) {
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
  }, [key])
  return loaded
}
