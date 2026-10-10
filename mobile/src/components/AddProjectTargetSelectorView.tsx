import { AddProjectTargetSelector, type AddProjectTarget } from './AddProjectTargetSelector'

export function AddProjectTargetSelectorView({
  busy,
  targets,
  selectedId,
  onSelect
}: {
  busy: boolean
  targets: readonly AddProjectTarget[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <AddProjectTargetSelector
      busy={busy}
      targets={targets}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  )
}
