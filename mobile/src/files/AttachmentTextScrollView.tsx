import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Platform, ScrollView, Text, View, VirtualizedList } from 'react-native'
import type { AttachmentTextSource } from '../../../src/shared/attachment-text-source'
import {
  AttachmentTextViewport,
  type TextAnchor
} from '../../../src/shared/attachment-text-viewport'
import { chatAttachmentPreviewStyles as styles } from './mobile-file-preview-styles'

function scrollElement(list: VirtualizedList<number> | null): HTMLElement | null {
  if (Platform.OS !== 'web') {
    return null
  }
  const ref = list?.getScrollRef()
  const node: unknown =
    ref && 'getScrollableNode' in ref && typeof ref.getScrollableNode === 'function'
      ? ref.getScrollableNode()
      : ref
  return node instanceof HTMLElement ? node : null
}

export function AttachmentTextScrollView({
  source,
  revision,
  demand
}: {
  source: AttachmentTextSource
  revision: number
  demand: (indices: number[]) => void
}) {
  const list = useRef<VirtualizedList<number>>(null)
  const anchor = useRef<TextAnchor>({ block: 0, row: 0 })
  const atEnd = useRef(false)
  const previous = useRef<AttachmentTextViewport | null>(null)
  const [position, setPosition] = useState({ top: 0, height: 0, rowHeight: 19 })
  const layout = useMemo(
    () => new AttachmentTextViewport(source, position.rowHeight, position.height, revision),
    [source, revision, position.rowHeight, position.height]
  )
  useLayoutEffect(() => {
    const old = previous.current
    const live = scrollElement(list.current)?.scrollTop ?? old?.position(anchor.current) ?? 0
    if (
      old?.source !== source ||
      live < Math.min(old.total - old.height, layout.total - layout.height) - 1
    ) {
      atEnd.current = false
    }
    const top = layout.restore(old, live, anchor.current, atEnd.current)
    const endExtentChanged = old?.source === source && atEnd.current && old.total !== layout.total
    previous.current = layout
    if (Math.abs(top - live) >= 1 || endExtentChanged) {
      list.current?.scrollToOffset({ offset: top, animated: false })
    }
    anchor.current = layout.anchor(top)
    setPosition((old) => (old.top === top ? old : { ...old, top }))
  }, [source, layout, position.height])
  const block = layout.anchor(position.top).block
  const needsNext =
    source.cachedBlock(block) !== undefined &&
    (source.rowCount(block) - layout.anchor(position.top).row) * position.rowHeight <
      position.height + 4 * position.rowHeight &&
    block + 1 < source.blockCount
  useEffect(() => {
    if (source.size !== null) {
      demand(needsNext ? [block, block + 1] : [block])
    }
  }, [source, block, needsNext, demand])
  const model = useRef(layout)
  useLayoutEffect(() => {
    model.current = layout
  })
  useEffect(() => {
    const node = scrollElement(list.current)
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
  const rows = layout.rows(position.top)
  const contentWidth = Math.max(width, source.displayUnits * cellWidth + 32)
  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={{ flexGrow: 1 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <VirtualizedList
        ref={list}
        data={source}
        extraData={layout}
        style={{ width: contentWidth }}
        onLayout={(event) =>
          setPosition((old) => ({ ...old, height: event.nativeEvent.layout.height }))
        }
        getItem={(_data, index) => index}
        getItemCount={() => source.blockCount}
        keyExtractor={String}
        getItemLayout={(_data, index) => ({
          index,
          length: layout.heights[index]!,
          offset: layout.starts[index]!
        })}
        renderItem={({ index }) => <View style={{ height: layout.heights[index] }} />}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={3}
        removeClippedSubviews={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          const top = event.nativeEvent.contentOffset.y
          anchor.current = layout.anchor(top)
          atEnd.current = top > 0 && top + position.height >= layout.total - 1
          setPosition((old) => ({ ...old, top }))
        }}
        ListHeaderComponent={
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
          >
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
                    height: position.rowHeight,
                    left: 16,
                    width: contentWidth - 32
                  }
                ]}
              >
                {row.text.replace(/\n$/, '') || '\u00a0'}
              </Text>
            ))}
          </View>
        }
      />
    </ScrollView>
  )
}
