import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { ConfirmContent, type ConfirmModalProps } from './ConfirmContent'

/** The confirmation drawn in React Native, for web and for `media` or `details` a system alert can't hold. */
export function DrawnConfirmModal({ visible, ...content }: ConfirmModalProps) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}
