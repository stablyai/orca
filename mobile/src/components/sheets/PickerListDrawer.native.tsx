import { useRef } from 'react'
import type { PickerListDrawerProps, PickerListItem } from './DrawnPickerListDrawer'
import { NativeSinglePicker } from './NativeSinglePicker'

export type { PickerListDrawerProps, PickerListItem } from './DrawnPickerListDrawer'

/** The platform's pick-one sheet or dialog. */
export function PickerListDrawer<T extends PickerListItem>(props: PickerListDrawerProps<T>) {
  const picked = useRef<T | null>(null)
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
        picked.current = props.items.find((item) => item.id === id) ?? null
      }}
      onClose={props.onClose}
      // A pick often opens the next sheet, which can only present once this one has gone.
      onAfterClose={() => {
        const item = picked.current
        picked.current = null
        if (item) {
          props.onSelect(item)
        }
      }}
    />
  )
}
