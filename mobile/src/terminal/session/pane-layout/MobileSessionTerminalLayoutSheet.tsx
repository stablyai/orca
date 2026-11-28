import { Columns2, LayoutGrid, Rows2, SquareTerminal } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useWindowDimensions } from 'react-native'
import { windowFitsSideBySide } from './mobile-terminal-pane-layout'
import type { TerminalSplitLayout } from '../../../storage/preferences'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'

export function MobileSessionTerminalLayoutSheet({
  controller,
  visible,
  onClose
}: {
  controller: MobileSessionController
  visible: boolean
  onClose: () => void
}) {
  const t = useMobileTranslation()
  // Too narrow for columns (a phone held upright): one terminal or two stacked, as the split draws.
  const wide = windowFitsSideBySide(useWindowDimensions().width)
  const {
    canSplitTerminals,
    terminalSplitActive,
    toggleTerminalSplit,
    terminalSplitLayout,
    setTerminalSplitLayout
  } = controller
  const chooseSplitLayout = (layout: TerminalSplitLayout) => {
    setTerminalSplitLayout(layout)
    if (!terminalSplitActive) {
      toggleTerminalSplit()
    }
  }
  const splits = wide
    ? ([
        { layout: 'auto', label: t('session.terminalLayoutSheet.auto', 'Auto'), icon: LayoutGrid },
        {
          layout: 'side-by-side',
          label: t('session.terminalLayoutSheet.sideBySide', 'Side by side'),
          icon: Columns2
        },
        {
          layout: 'stacked',
          label: t('session.terminalLayoutSheet.stacked', 'Stacked'),
          icon: Rows2
        }
      ] as const)
    : ([
        {
          layout: 'stacked',
          label: t('session.terminalLayoutSheet.stacked', 'Stacked'),
          icon: Rows2
        }
      ] as const)
  return (
    <ActionSheetModal
      visible={visible}
      title={t('session.terminalLayoutSheet.title', 'Terminal layout')}
      onClose={onClose}
      actions={[
        {
          label: t('session.terminalLayoutSheet.oneTerminal', 'One terminal'),
          icon: SquareTerminal,
          checked: !terminalSplitActive,
          onPress: () => {
            if (terminalSplitActive) {
              toggleTerminalSplit()
            }
          }
        },
        ...splits.map(({ layout, label, icon }) => {
          // Narrow, every split draws as rows, so Stacked is the one that's on.
          const checked = terminalSplitActive && (!wide || terminalSplitLayout === layout)
          return {
            label,
            icon,
            checked,
            disabled: !canSplitTerminals && !terminalSplitActive,
            hint:
              !canSplitTerminals && !terminalSplitActive
                ? t(
                    'session.terminalLayoutSheet.needsSecondTerminal',
                    'Open a second terminal first'
                  )
                : undefined,
            // Re-picking the checked row keeps the layout saved for a wider window.
            onPress: () => {
              if (!checked) {
                chooseSplitLayout(layout)
              }
            }
          }
        })
      ]}
    />
  )
}
