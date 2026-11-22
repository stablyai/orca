import { useRef } from 'react'
import type { PickerListDrawerProps, PickerListItem } from './DrawnPickerListDrawer'
import { NativeSinglePicker } from './NativeSinglePicker'

export type { PickerListDrawerProps, PickerListItem } from './DrawnPickerListDrawer'

/** The platform's pick-one sheet or dialog. */
export function PickerListDrawer<T extends PickerListItem>(props: PickerListDrawerProps<T>) {
  // The pick-time onSelect: the owner may clear what it closes over once the sheet closes.
  const picked = useRef<{ item: T; onSelect: (item: T) => void } | null>(null)
  const renderIcon = props.renderIcon
  return (
    <NativeSinglePicker
      visible={props.visible}
      title={props.title}
      sections={[
        {
          title: undefined,
          options: props.items.map((item) => ({
            value: item.id,
            label: item.label,
            subtitle: item.detail || undefined,
            renderIcon: renderIcon ? () => renderIcon(item) : undefined
          }))
        }
      ]}
      selected={props.selectedId}
      onSelect={(id) => {
        const item = props.items.find((candidate) => candidate.id === id)
        picked.current = item ? { item, onSelect: props.onSelect } : null
      }}
      onClose={props.onClose}
      // A pick often opens the next sheet, which can only present once this one has gone.
      onAfterClose={() => {
        const pending = picked.current
        picked.current = null
        pending?.onSelect(pending.item)
      }}
    />
  )
}
