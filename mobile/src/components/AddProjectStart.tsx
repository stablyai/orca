import type { ReactNode } from 'react'
import { ActionSheetContent } from './ActionSheetModal'
import { FolderOpen, Globe, Plus } from 'lucide-react-native'

export function AddProjectStart({
  targetSelector,
  onBeforeAction,
  onBrowse,
  onClone,
  onCreate
}: {
  targetSelector: ReactNode
  onBeforeAction: () => void
  onBrowse: () => void
  onClone: () => void
  onCreate: () => void
}) {
  return (
    <>
      {targetSelector}
      <ActionSheetContent
        title="Add project"
        actions={[
          {
            label: 'Browse folder',
            icon: FolderOpen,
            hint: 'Existing Git repository or folder on this host',
            onPress: onBrowse
          },
          {
            label: 'Clone from URL',
            icon: Globe,
            hint: 'Clone a remote Git repository',
            onPress: onClone
          },
          {
            label: 'Create new project',
            icon: Plus,
            hint: 'Start from an empty folder',
            onPress: onCreate
          }
        ].map((action) => ({
          ...action,
          onPress: () => {
            onBeforeAction()
            action.onPress()
          }
        }))}
      />
    </>
  )
}
