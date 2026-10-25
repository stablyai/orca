import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import type { MobileModelSceneHandle } from './mobile-model-scene'
import { type MobileModelSummary, MobileModelPreviewFooter } from './MobileModelPreviewFooter'

type ModelPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; summary: MobileModelSummary }
  | { status: 'error'; message: string }

const UNSUPPORTED_MESSAGE = 'Compressed (Draco or meshopt) models open in the desktop app'
const FAILED_MESSAGE = 'Unable to display this 3D model'
const CONTEXT_LOST_MESSAGE = 'The 3D view was reset. Reopen the file to view it again'

export function MobileModelPreview({ base64, title }: { base64: string; title: string }) {
  const hostRef = useRef<View>(null)
  const sceneRef = useRef<MobileModelSceneHandle | null>(null)
  const [state, setState] = useState<ModelPreviewState>({ status: 'loading' })
  const [guidesVisible, setGuidesVisible] = useState(true)
  const [animationIndex, setAnimationIndex] = useState(0)
  const [animationPaused, setAnimationPaused] = useState(false)

  useEffect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-native-web renders View as a div and forwards the ref to it; this module only ever runs in that build.
    const host = hostRef.current as unknown as HTMLElement | null
    if (!host) {
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    setGuidesVisible(true)
    setAnimationIndex(0)
    setAnimationPaused(false)
    void (async () => {
      try {
        // Why lazy: three.js is a large chunk that only a model preview needs.
        const { createMobileModelScene, MobileModelUnsupportedError } =
          await import('./mobile-model-scene')
        try {
          const handle = await createMobileModelScene(
            host,
            base64,
            () => setState({ status: 'error', message: CONTEXT_LOST_MESSAGE }),
            () => cancelled
          )
          if (handle) {
            sceneRef.current = handle
            handle.playAnimation(0)
            setState({
              status: 'ready',
              summary: {
                ...handle.stats,
                ...handle.dimensions,
                gridCellSize: handle.gridCellSize,
                animationNames: handle.animationNames
              }
            })
          }
        } catch (error) {
          if (!cancelled) {
            setState({
              status: 'error',
              message:
                error instanceof MobileModelUnsupportedError ? UNSUPPORTED_MESSAGE : FAILED_MESSAGE
            })
          }
        }
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: FAILED_MESSAGE })
        }
      }
    })()
    return () => {
      cancelled = true
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [base64])

  return (
    <View style={styles.imageContainer}>
      <View style={styles.modelStage}>
        <View
          ref={hostRef}
          style={[styles.modelCanvasHost, state.status === 'error' && styles.modelCanvasHidden]}
          accessibilityLabel={`${title} 3D model`}
        />
        {state.status === 'loading' && (
          <View style={[styles.state, styles.modelOverlay]}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        )}
        {state.status === 'error' && (
          <View style={[styles.state, styles.modelOverlay]}>
            <Text style={styles.stateText}>{state.message}</Text>
          </View>
        )}
      </View>
      {state.status === 'ready' && (
        <MobileModelPreviewFooter
          summary={state.summary}
          guidesVisible={guidesVisible}
          animationIndex={animationIndex}
          animationPaused={animationPaused}
          onResetView={() => sceneRef.current?.resetView()}
          onGuidesVisibleChange={(visible) => {
            sceneRef.current?.setGuidesVisible(visible)
            setGuidesVisible(visible)
          }}
          onAnimationIndexChange={(index) => {
            sceneRef.current?.playAnimation(index)
            setAnimationIndex(index)
            setAnimationPaused(false)
          }}
          onAnimationPausedChange={(paused) => {
            sceneRef.current?.setAnimationPaused(paused)
            setAnimationPaused(paused)
          }}
        />
      )}
    </View>
  )
}
