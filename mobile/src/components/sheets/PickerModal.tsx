import { useShellDialog } from '../../platform/page-dialogs/use-shell-dialog'
import { DrawnPickerModal, type PickerModalProps } from './DrawnPickerModal'

export type { PickerModalProps, PickerOption } from './DrawnPickerModal'

/** The shell's pick-one sheet when it offers one; icons, long-press and a subtitle stay drawn. */
export function PickerModal<T extends string = string>(props: PickerModalProps<T>) {
  const expressible =
    !props.onLongSelect && !props.subtitle && props.options.every((option) => !option.renderIcon)
  const native = useShellDialog({
    visible: props.visible,
    request: expressible
      ? {
          action: 'pick',
          title: props.title,
          options: props.options.map((option) => ({
            value: option.value,
            label: option.label,
            subtitle: option.subtitle,
            section: option.section,
            disabled: option.disabled === true
          })),
          selected: props.selected,
          searchable: props.searchable === true
        }
      : null,
    onAnswer: ({ outcome, value }) => {
      const option = props.options.find((candidate) => candidate.value === value)
      if (outcome === 'confirm' && option && !option.disabled) {
        props.onSelect(option.value)
      }
      props.onClose()
      props.onAfterClose?.()
    },
    onWithdrawn: props.onAfterClose
  })
  return native ? null : <DrawnPickerModal {...props} />
}
