import { DrawnPickerModal } from './DrawnPickerModal'
import type { PickerSection } from './picker-options'

export type NativeSinglePickerProps<T extends string> = {
  visible: boolean
  title: string
  sections: PickerSection<T>[]
  selected: T
  onSelect: (value: T) => void
  onClose: () => void
  onAfterClose?: () => void
  /** Shows a search field that filters rows by label and subtitle. */
  searchable?: boolean
}

/** Web has no platform picker sheet; it keeps the drawn one. */
export function NativeSinglePicker<T extends string>({
  sections,
  ...props
}: NativeSinglePickerProps<T>) {
  return <DrawnPickerModal {...props} options={sections.flatMap((section) => section.options)} />
}
