import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceCreationKind } from './creation/forms/new-worktree-modal-types'

export function WorkspaceCreationTabs(props: {
  selected: WorkspaceCreationKind
  disabled?: boolean
  onSelect: (kind: WorkspaceCreationKind) => void
}) {
  const t = useMobileTranslation()
  return (
    <MobileSegmentedControl
      tabs
      fill
      onSheet
      selected={props.selected}
      disabled={props.disabled}
      onSelect={props.onSelect}
      style={{ alignSelf: 'stretch' }}
      segments={[
        { value: 'worktree', label: t('newWorkspace.kind.worktree', 'Worktree') },
        { value: 'chat', label: t('newWorkspace.kind.chat', 'Chat') }
      ]}
    />
  )
}
