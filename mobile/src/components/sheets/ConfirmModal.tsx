import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { ConfirmContent, type ConfirmModalProps } from './ConfirmContent'

export { ConfirmContent }
export type { ConfirmModalProps }

export function ConfirmModal({ visible, ...content }: ConfirmModalProps) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}
