import { useRef } from 'react'
import { PanResponder, Platform, StyleSheet, View } from 'react-native'
import { shellBackEdgeClaims, shellBackEdgePops } from './shell-back-edge'

const EDGE_WIDTH = 24

// A sibling of the WebView, not a parent capture: WKWebView takes the touch before a parent responder runs.
export function ShellPageBackEdge({
  active,
  onBack
}: {
  active: boolean
  onBack: () => void
}): React.JSX.Element | null {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => shellBackEdgeClaims(gesture.dx, gesture.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_event, gesture) => {
        if (shellBackEdgePops(gesture.dx, gesture.dy)) {
          onBackRef.current()
        }
      }
    })
  ).current
  if (!active || Platform.OS !== 'ios') {
    return null
  }
  return <View testID="shell-page-back-edge" style={styles.edge} {...responder.panHandlers} />
}

const styles = StyleSheet.create({
  edge: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    zIndex: 20
  }
})
