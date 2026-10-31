import type { ReactNode } from 'react'
import { View } from 'react-native'
import { MobileSwitch } from '../components/MobileSwitch'
import { ListGroup } from '../components/list/ListGroup'
import { ListRow } from '../components/list/ListRow'
import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'

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
}) {
  return (
    <ListRow
      title={props.label}
      // An empty leading slot indents the row under the option it qualifies.
      leading={props.indent ? <View /> : undefined}
      accessory={
        <MobileSwitch
          value={props.value}
          onValueChange={props.onChange}
          accessibilityLabel={props.label}
        />
      }
    />
  )
}

export function DrillRow(props: { label: string; value: string; onPress: () => void }) {
  return (
    <ListRow
      title={props.label}
      value={props.value || undefined}
      navigates
      onPress={props.onPress}
    />
  )
}
