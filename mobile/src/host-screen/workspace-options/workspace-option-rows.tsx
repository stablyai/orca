import type { ReactNode } from 'react'
import { View } from 'react-native'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import type { WorkspaceViewChoice } from '../../../../src/shared/workspace-view/workspace-view-options'

export function CheckRow(props: {
  label: string
  checked: boolean
  onPress: () => void
  detail?: string
  leading?: ReactNode
  radio?: boolean
  disabled?: boolean
}) {
  return (
    <ListRow
      title={props.label}
      subtitle={props.detail}
      leading={props.leading}
      selected={props.checked}
      disabled={props.disabled}
      onPress={props.onPress}
      accessibilityRole={props.radio ? 'radio' : 'checkbox'}
    />
  )
}

export function ChoiceRows<Id extends string>(props: {
  choices: readonly WorkspaceViewChoice<Id>[]
  selected: Id
  onSelect: (id: Id) => void
  disabled?: boolean
}) {
  return (
    <ListGroup>
      {props.choices.map((choice) => (
        <CheckRow
          key={choice.id}
          label={choice.label}
          detail={choice.description}
          radio
          checked={choice.id === props.selected}
          disabled={props.disabled}
          onPress={() => props.onSelect(choice.id)}
        />
      ))}
    </ListGroup>
  )
}

/* Only the switch takes the tap, avoiding duplicate writes on web. */
export function SwitchRow(props: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  indent?: boolean
  detail?: string
  disabled?: boolean
  /** When the label alone does not say what the switch does. */
  accessibilityLabel?: string
}) {
  return (
    <ListRow
      title={props.label}
      subtitle={props.detail}
      // An empty leading slot indents the row under the option it qualifies.
      leading={props.indent ? <View /> : undefined}
      accessory={
        <MobileSwitch
          value={props.value}
          onValueChange={props.onChange}
          disabled={props.disabled}
          accessibilityLabel={props.accessibilityLabel ?? props.label}
        />
      }
    />
  )
}

/** `detail` puts the value under the label, for one too long to share its line. */
export function DrillRow(props: {
  label: string
  value: string
  onPress: () => void
  detail?: boolean
  disabled?: boolean
}) {
  return (
    <ListRow
      title={props.label}
      value={(!props.detail && props.value) || undefined}
      subtitle={(props.detail && props.value) || undefined}
      accessibilityLabel={props.detail ? `${props.label}, ${props.value}` : undefined}
      navigates
      onPress={props.onPress}
      disabled={props.disabled}
    />
  )
}
