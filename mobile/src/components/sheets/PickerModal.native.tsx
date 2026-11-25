import { DrawnPickerModal, type PickerModalProps } from './DrawnPickerModal'
import { NativeSinglePicker } from './NativeSinglePicker'
import { groupPickerSections } from './picker-options'

export type { PickerModalProps, PickerOption } from './DrawnPickerModal'

/**
 * The platform's pick-one sheet or dialog. Long-press and a picker subtitle need rows the
 * native list can't draw, so those stay drawn.
 */
export function PickerModal<T extends string = string>(props: PickerModalProps<T>) {
  if (props.onLongSelect || props.subtitle) {
    return <DrawnPickerModal {...props} />
  }
  return (
    <NativeSinglePicker
      visible={props.visible}
      title={props.title}
      sections={groupPickerSections(props.options)}
      selected={props.selected}
      onSelect={props.onSelect}
      onClose={props.onClose}
      onAfterClose={props.onAfterClose}
      searchable={props.searchable}
    />
  )
}
