import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Platform, ScrollView, Text, View } from 'react-native'
import type {
  AttachmentTextSource,
  AttachmentTextWindow
} from '../../../src/shared/attachment-text-source'
import { AttachmentTextViewport } from '../../../src/shared/attachment-text-viewport'
import { chatAttachmentPreviewStyles as styles } from './mobile-file-preview-styles'

function scrollElement(view: ScrollView | null): HTMLElement | null {
  if (Platform.OS !== 'web') {
    return null
  }
  const node: unknown =
    view && 'getScrollableNode' in view && typeof view.getScrollableNode === 'function'
      ? view.getScrollableNode()
      : view
  return node instanceof HTMLElement ? node : null
}

export function AttachmentTextScrollView({
  source,
  revision,
  demand
}: {
  source: AttachmentTextSource
  revision: number
  demand: (window: AttachmentTextWindow) => void
}) {
  const scroll = useRef<ScrollView>(null)
  const nativeOffset = useRef(0)
  const [position, setPosition] = useState({ height: 0, rowHeight: 19 })
  const measured = useMemo(
    () => new AttachmentTextViewport(source, position.rowHeight, position.height, revision),
    [source, revision, position.rowHeight, position.height]
  )
  const [projection, setProjection] = useState(() => ({ layout: measured, top: 0 }))
  const { layout } = projection
  // Snapshot the live old track before publishing an extent that could clamp an undelivered gesture.
  useLayoutEffect(() => {
    if (layout !== measured) {
      const live = scrollElement(scroll.current)?.scrollTop ?? nativeOffset.current
      setProjection({ layout: measured, top: measured.restore(layout, live) })
    }
  }, [measured, layout, projection.top])
  useLayoutEffect(() => {
    const live = scrollElement(scroll.current)?.scrollTop ?? nativeOffset.current
    if (Math.abs(live - projection.top) / layout.scale > 0.01) {
      scroll.current?.scrollTo({ y: projection.top, animated: false })
      nativeOffset.current = projection.top
    }
    const actual = scrollElement(scroll.current)?.scrollTop ?? nativeOffset.current
    setProjection((old) => (old.top === actual ? old : { ...old, top: actual }))
  }, [layout])
  const window = layout.window(projection.top)
  useEffect(() => {
    if (source.size !== null) {
      demand(window)
    }
  }, [source, demand, window.block, window.row, window.rows, window.fraction, window.tail])
  const model = useRef(layout)
  useLayoutEffect(() => {
    model.current = layout
  })
  useEffect(() => {
    const node = scrollElement(scroll.current)
    if (!node) {
      return
    }
    const move = (pixels: number) => {
      node.scrollTop = model.current.move(model.current.anchor(node.scrollTop), pixels)
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        return
      }
      event.preventDefault()
      move(
        event.deltaY *
          (event.deltaMode === 1
            ? model.current.rowHeight
            : event.deltaMode === 2
              ? node.clientHeight
              : 1)
      )
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => {
      node.removeEventListener('wheel', wheel)
    }
  }, [])
  const [width, setWidth] = useState(0)
  const [cellWidth, setCellWidth] = useState(8)
  const rows = layout.rows(projection.top)
  const contentWidth = Math.max(width, source.displayUnits * cellWidth + 32)
  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={{ flexGrow: 1 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        ref={scroll}
        style={{ width: contentWidth }}
        onLayout={(event) =>
          setPosition((old) => ({ ...old, height: event.nativeEvent.layout.height }))
        }
        scrollEventThrottle={16}
        onScroll={(event) => {
          const top = event.nativeEvent.contentOffset.y
          nativeOffset.current = top
          setProjection((old) => ({ ...old, top }))
        }}
      >
        <View style={{ height: layout.total, position: 'relative' }}>
          <Text
            accessible={false}
            style={[
              styles.textPreview,
              { position: 'absolute', opacity: 0, alignSelf: 'flex-start' }
            ]}
            onTextLayout={(event) => {
              const line = event.nativeEvent.lines[0]
              if (line?.height) {
                setPosition((old) => ({ ...old, rowHeight: line.height }))
                setCellWidth(line.width)
              }
            }}
          >
            M
          </Text>
          {rows.map((row) => (
            <Text
              key={row.key}
              testID="attachment-text-segment"
              selectable
              numberOfLines={1}
              style={[
                styles.textPreview,
                {
                  ...(Platform.OS === 'web' ? { whiteSpace: 'pre' as const } : {}),
                  position: 'absolute',
                  top: row.top,
                  height: layout.rowHeight,
                  left: 16,
                  width: contentWidth - 32
                }
              ]}
            >
              {row.text.replace(/\n$/, '') || '\u00a0'}
            </Text>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  )
}
