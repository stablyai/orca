import { Axis3d, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export type MobileModelSummary = {
  vertices: number
  triangles: number
  width: number
  height: number
  depth: number
  gridCellSize: number
  animationNames: string[]
}

type Props = {
  summary: MobileModelSummary
  guidesVisible: boolean
  animationIndex: number
  animationPaused: boolean
  onResetView: () => void
  onGuidesVisibleChange: (visible: boolean) => void
  onAnimationIndexChange: (index: number) => void
  onAnimationPausedChange: (paused: boolean) => void
}

function formatLength(value: number): string {
  return Number(value.toPrecision(3)).toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function FooterButton(props: {
  label: string
  selected?: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.modelFooterButton,
        (pressed || props.selected) && styles.backButtonPressed
      ]}
    >
      {props.children}
    </Pressable>
  )
}

export function MobileModelPreviewFooter({ summary, ...options }: Props) {
  const { animationNames } = summary
  const animationName =
    animationNames[options.animationIndex] || `Animation ${options.animationIndex + 1}`
  return (
    <View style={styles.modelFooter}>
      <View style={styles.modelFooterControls}>
        <FooterButton label="Reset view" onPress={options.onResetView}>
          <RotateCcw size={16} color={colors.textSecondary} />
        </FooterButton>
        <FooterButton
          label="Grid and axes"
          selected={options.guidesVisible}
          onPress={() => options.onGuidesVisibleChange(!options.guidesVisible)}
        >
          <Axis3d size={16} color={colors.textSecondary} />
        </FooterButton>
        {animationNames.length > 0 && (
          <FooterButton
            label={options.animationPaused ? 'Play animation' : 'Pause animation'}
            onPress={() => options.onAnimationPausedChange(!options.animationPaused)}
          >
            {options.animationPaused ? (
              <Play size={16} color={colors.textSecondary} />
            ) : (
              <Pause size={16} color={colors.textSecondary} />
            )}
          </FooterButton>
        )}
        {animationNames.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Animation ${animationName}, switch to the next one`}
            onPress={() =>
              options.onAnimationIndexChange((options.animationIndex + 1) % animationNames.length)
            }
            style={({ pressed }) => [styles.modelFooterClip, pressed && styles.backButtonPressed]}
          >
            <Text style={styles.modelFooterText} numberOfLines={1}>
              {animationName}
            </Text>
            <ChevronRight size={14} color={colors.textMuted} />
          </Pressable>
        ) : animationNames.length === 1 ? (
          <Text style={styles.modelFooterText} numberOfLines={1}>
            {animationName}
          </Text>
        ) : null}
      </View>
      <Text style={styles.modelFooterText}>
        {`${summary.vertices.toLocaleString()} vertices · ${summary.triangles.toLocaleString()} triangles`}
      </Text>
      <Text style={styles.modelFooterText}>
        {`${formatLength(summary.width)} × ${formatLength(summary.height)} × ${formatLength(summary.depth)} m`}
        {options.guidesVisible ? ` · grid ${formatLength(summary.gridCellSize)} m` : ''}
      </Text>
    </View>
  )
}
