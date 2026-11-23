import { useRef } from 'react'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { ActionSheetContent, type ActionSheetModalProps } from './ActionSheetContent'

/** The action sheet drawn in React Native, for web and for sheets inside a shared drawer Modal. */
export function DrawnActionSheetModal({
  visible,
  title,
  titleAccessibilityLabel,
  message,
  headerIcon,
  groupDestructive,
  actions,
  onClose,
  onAfterClose
}: ActionSheetModalProps) {
  const pendingActionRef = useRef<(() => void) | null>(null)
  const sequencedActions = actions.map((action) =>
    action.closeBeforePress
      ? {
          ...action,
          onPress: () => {
            pendingActionRef.current = action.onPress
          }
        }
      : action
  )

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        // Wait for iOS sheet window to unmount before presenting another native modal.
        const pendingAction = pendingActionRef.current
        pendingActionRef.current = null
        pendingAction?.()
        onAfterClose?.()
      }}
      dragContentToDismiss
    >
      <ActionSheetContent
        title={title}
        titleAccessibilityLabel={titleAccessibilityLabel}
        message={message}
        headerIcon={headerIcon}
        groupDestructive={groupDestructive}
        actions={sequencedActions}
        onClose={onClose}
      />
    </BottomDrawer>
  )
}
