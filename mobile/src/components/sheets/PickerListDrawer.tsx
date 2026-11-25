import { useShellDialog } from '../../platform/page-dialogs/use-shell-dialog'
import {
  DrawnPickerListDrawer,
  type PickerListDrawerProps,
  type PickerListItem
} from './DrawnPickerListDrawer'

export type { PickerListDrawerProps, PickerListItem } from './DrawnPickerListDrawer'

/** The shell's pick-one sheet when it offers one; rows with icons stay drawn. */
export function PickerListDrawer<T extends PickerListItem>(props: PickerListDrawerProps<T>) {
  const native = useShellDialog({
    visible: props.visible,
    request: props.renderIcon
      ? null
      : {
          action: 'pick',
          title: props.title,
          options: props.items.map((item) => ({
            value: item.id,
            label: item.label,
            subtitle: item.detail || undefined,
            disabled: false
          })),
          selected: props.selectedId,
          searchable: false
        },
    // The shell answers once its sheet has gone, the moment the drawn one hands over the item.
    onAnswer: ({ outcome, value }) => {
      const item = props.items.find((candidate) => candidate.id === value)
      props.onClose()
      if (outcome === 'confirm' && item) {
        props.onSelect(item)
      }
    }
  })
  return native ? null : <DrawnPickerListDrawer {...props} />
}
