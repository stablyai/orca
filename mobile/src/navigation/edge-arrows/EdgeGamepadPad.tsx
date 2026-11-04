import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerSelection } from '../../platform/haptics'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type {
  EdgeDirection,
  EdgeNavigationTarget,
  GamepadActionId
} from './edge-navigation-context'
import { screenEdgeNavigationStyles as styles } from './screen-edge-navigation-styles'

type RenderDirectionControl = (options: {
  direction: EdgeDirection
  positionStyle: Record<string, number>
  accessibilityLabel: string
}) => React.JSX.Element

type ActionButtonSpec = {
  readonly id: GamepadActionId
  readonly shortLabel: string
  readonly accessibilityLabel: string
  readonly positionStyle: Record<string, number>
  readonly fallbackDirection: EdgeDirection
  readonly primary?: boolean
}

export function EdgeGamepadPad({
  target,
  getPaneNode,
  bottomLeftOffset,
  bottomRightOffset,
  upLabel,
  downLabel,
  leftLabel,
  rightLabel,
  renderDirectionButton
}: {
  target: EdgeNavigationTarget
  getPaneNode: () => unknown
  bottomLeftOffset: number
  bottomRightOffset: number
  upLabel: string
  downLabel: string
  leftLabel: string
  rightLabel: string
  renderDirectionButton: RenderDirectionControl
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const isTerminal = target.kind === 'terminal'

  const actionSpecs: ActionButtonSpec[] = [
    {
      id: 'north',
      shortLabel: isTerminal ? 'Tab' : '↑↑',
      accessibilityLabel: isTerminal
        ? t('navigation.edgeArrows.gamepadNorthTerminal', 'Gamepad top button (Tab)')
        : t('navigation.edgeArrows.gamepadNorthScroll', 'Gamepad top button (Scroll up)'),
      positionStyle: { top: 4, left: 37 },
      fallbackDirection: 'up'
    },
    {
      id: 'west',
      shortLabel: isTerminal ? 'Alt+M' : '⇤',
      accessibilityLabel: isTerminal
        ? t('navigation.edgeArrows.gamepadWestTerminal', 'Gamepad left button (Alt+M mode)')
        : t('navigation.edgeArrows.gamepadWestScroll', 'Gamepad left button (Previous tab)'),
      positionStyle: { top: 37, left: 4 },
      fallbackDirection: 'left'
    },
    {
      id: 'east',
      shortLabel: isTerminal ? 'Esc' : '⇥',
      accessibilityLabel: isTerminal
        ? t('navigation.edgeArrows.gamepadEastTerminal', 'Gamepad right button (Escape)')
        : t('navigation.edgeArrows.gamepadEastScroll', 'Gamepad right button (Next tab)'),
      positionStyle: { top: 37, right: 4 },
      fallbackDirection: 'right'
    },
    {
      id: 'south',
      shortLabel: isTerminal ? '⏎' : '↓↓',
      accessibilityLabel: isTerminal
        ? t('navigation.edgeArrows.gamepadSouthTerminal', 'Gamepad primary button (Enter)')
        : t('navigation.edgeArrows.gamepadSouthScroll', 'Gamepad primary button (Scroll down)'),
      positionStyle: { bottom: 4, left: 37 },
      fallbackDirection: 'down',
      primary: true
    }
  ]

  const resolveActionEnabled = (spec: ActionButtonSpec): boolean => {
    if (target.canPerformAction) {
      return target.canPerformAction(spec.id)
    }
    if (target.canNavigate) {
      return target.canNavigate(spec.fallbackDirection)
    }
    return true
  }

  const fireAction = (spec: ActionButtonSpec): void => {
    triggerSelection()
    const node = getPaneNode()
    if (target.performAction) {
      void target.performAction(spec.id, node)
      return
    }
    void target.preparePress(spec.fallbackDirection, node).tap()
  }

  return (
    <>
      <View
        testID="gamepad-dpad-cluster"
        pointerEvents="box-none"
        style={[styles.gamepadHousing, { left: 10, bottom: bottomLeftOffset }]}
      >
        <View pointerEvents="none" style={styles.gamepadCenterHub}>
          {target.modifierActive ? <View style={styles.modifierDot} /> : null}
        </View>
        {renderDirectionButton({
          direction: 'up',
          positionStyle: { top: 4, left: 37 },
          accessibilityLabel: upLabel
        })}
        {renderDirectionButton({
          direction: 'down',
          positionStyle: { bottom: 4, left: 37 },
          accessibilityLabel: downLabel
        })}
        {renderDirectionButton({
          direction: 'left',
          positionStyle: { top: 38, left: 4 },
          accessibilityLabel: leftLabel
        })}
        {renderDirectionButton({
          direction: 'right',
          positionStyle: { top: 38, right: 4 },
          accessibilityLabel: rightLabel
        })}
      </View>

      <View
        testID="gamepad-action-cluster"
        pointerEvents="box-none"
        style={[styles.gamepadHousing, { right: 10, bottom: bottomRightOffset }]}
      >
        <View pointerEvents="none" style={styles.gamepadCenterHub} />
        {actionSpecs.map((spec) => {
          const enabled = resolveActionEnabled(spec)
          return (
            <Pressable
              key={spec.id}
              testID={`gamepad-action-${spec.id}`}
              accessibilityRole="button"
              accessibilityLabel={spec.accessibilityLabel}
              disabled={!enabled}
              hitSlop={6}
              onPress={() => {
                if (enabled) {
                  fireAction(spec)
                }
              }}
              style={({ pressed }) => [
                styles.gamepadActionButton,
                spec.primary === true && styles.gamepadActionPrimary,
                spec.positionStyle,
                target.modifierActive && styles.edgeControlModifier,
                pressed && styles.edgeControlActive,
                pressed && styles.edgeControlPressed,
                !enabled && styles.edgeControlDisabled
              ]}
            >
              <Text style={styles.gamepadActionLabel}>{spec.shortLabel}</Text>
            </Pressable>
          )
        })}
      </View>
    </>
  )
}
