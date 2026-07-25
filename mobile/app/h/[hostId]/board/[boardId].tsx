/**
 * E2 — collab board route on mobile.
 * Opens an offline-bundled canvas WebView for a boardId, joined to the mesh
 * sync room (same room desktop uses). Entry from host panel / session chrome.
 */
import { useMemo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { WebView } from 'react-native-webview'
import { buildCollabCanvasHtml } from '../../../../src/collab-canvas/collab-canvas-html'
import {
  mobileCollabCanvasRoomUri,
  resolveMobileCollabSyncOrigin
} from '../../../../src/collab-canvas/collab-canvas-room'

export default function CollabBoardRoute() {
  const router = useRouter()
  const { hostId, boardId, syncOrigin } = useLocalSearchParams<{
    hostId: string
    boardId: string
    syncOrigin?: string
  }>()

  const html = useMemo(() => {
    const id = typeof boardId === 'string' ? boardId : boardId?.[0] ?? 'board'
    const origin = resolveMobileCollabSyncOrigin(
      typeof syncOrigin === 'string' ? syncOrigin : undefined
    )
    return buildCollabCanvasHtml({
      boardId: id,
      roomUri: mobileCollabCanvasRoomUri(origin, id)
    })
  }, [boardId, syncOrigin])

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Collab · {boardId} · {hostId}
        </Text>
      </View>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.web}
        // Touch / pen: allow freehand; engine sets touch-action:none.
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        onMessage={(event) => {
          // room-open / ink-* messages for dogfood logging
          try {
            const msg = JSON.parse(event.nativeEvent.data)
            if (msg?.type === 'room-open' || msg?.type === 'ink-end') {
              // eslint-disable-next-line no-console
              console.log('[collab-board]', msg.type, msg.boardId)
            }
          } catch {
            // ignore non-JSON
          }
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333'
  },
  back: { color: '#8af', fontSize: 16 },
  title: { color: '#eee', fontSize: 14, flex: 1 },
  web: { flex: 1, backgroundColor: '#111' }
})
