import { useState, type SyntheticEvent } from 'react'
import type { PanZoomSize } from '../../../src/shared/pan-zoom-view'
import { useMobilePanZoom } from './use-mobile-pan-zoom'

type Props = {
  uri: string
  label: string
  /** The drawing's own size; raster images measure themselves on load. */
  size?: PanZoomSize | null
  /** Let fit enlarge past natural size; vectors stay sharp. */
  upscale?: boolean
  onError?: () => void
}

// DOM elements, not RN views: pointer capture and touch-action are what make pinch work in Android's WebView.
export function MobilePanZoomImage({ uri, label, size = null, upscale = false, onError }: Props) {
  const [loaded, setLoaded] = useState<{ uri: string; size: PanZoomSize } | null>(null)
  const content = size ?? (loaded?.uri === uri ? loaded.size : null)
  const panZoom = useMobilePanZoom(content, upscale)

  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget
    if (width > 0 && height > 0) {
      setLoaded({ uri, size: { width, height } })
    }
  }

  return (
    <div ref={panZoom.setCanvas} style={CANVAS_STYLE} {...panZoom.handlers}>
      <img
        src={uri}
        alt={label}
        draggable={false}
        onLoad={onLoad}
        onError={onError}
        style={
          content && panZoom.offset
            ? {
                ...IMAGE_STYLE,
                left: panZoom.offset.x,
                top: panZoom.offset.y,
                width: content.width * panZoom.scale,
                height: content.height * panZoom.scale
              }
            : HIDDEN_IMAGE_STYLE
        }
      />
    </div>
  )
}

const CANVAS_STYLE = {
  position: 'relative',
  flex: 1,
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  touchAction: 'none',
  userSelect: 'none'
} as const

const IMAGE_STYLE = { position: 'absolute', maxWidth: 'none', pointerEvents: 'none' } as const

const HIDDEN_IMAGE_STYLE = { ...IMAGE_STYLE, visibility: 'hidden' } as const
