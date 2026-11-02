import { Check, Columns2, LayoutGrid, Rows2, SquareTerminal } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { TerminalSplitLayout } from '../storage/preferences'
import type { MobileSessionController } from './use-mobile-session-controller'

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
  return (
    <ActionSheetModal
      visible={visible}
      title={t('session.terminalLayoutSheet.title', 'Terminal layout')}
      onClose={onClose}
      actions={[
        {
          label: t('session.terminalLayoutSheet.oneTerminal', 'One terminal'),
          icon: terminalSplitActive ? SquareTerminal : Check,
          hint: !terminalSplitActive
            ? t('session.terminalLayoutSheet.selected', 'Selected')
            : undefined,
          onPress: () => {
            if (terminalSplitActive) {
              toggleTerminalSplit()
            }
          }
        },
        ...(
          [
            {
              layout: 'auto',
              label: t('session.terminalLayoutSheet.auto', 'Auto'),
              icon: LayoutGrid,
              hint: t('session.terminalLayoutSheet.autoHint', 'Split to fit the available space')
            },
            {
              layout: 'side-by-side',
              label: t('session.terminalLayoutSheet.sideBySide', 'Side by side'),
              icon: Columns2,
              hint: t(
                'session.terminalLayoutSheet.sideBySideHint',
                'Two columns, even with the sidebar open'
              )
            },
            {
              layout: 'stacked',
              label: t('session.terminalLayoutSheet.stacked', 'Stacked'),
              icon: Rows2,
              hint: t('session.terminalLayoutSheet.stackedHint', 'Two rows in any orientation')
            }
          ] as const
        ).map(({ layout, label, icon, hint }) => ({
          label,
          icon: terminalSplitActive && terminalSplitLayout === layout ? Check : icon,
          hint:
            terminalSplitActive && terminalSplitLayout === layout
              ? t('session.terminalLayoutSheet.selectedHint', 'Selected · {{hint}}', {
                  hint
                })
              : hint,
          disabled: !canSplitTerminals && !terminalSplitActive,
          onPress: () => chooseSplitLayout(layout)
        }))
      ]}
    />
  )
}
