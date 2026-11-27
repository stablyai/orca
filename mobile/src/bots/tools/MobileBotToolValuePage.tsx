// One of Edit tool's values on a page of its own, as sheets can't open over the bot's drawer: the
// server's name, URL or executable, an argument, or a header or variable with its masked value.
import { useState } from 'react'
import { View } from 'react-native'
import { ListRow } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'

export type ToolValueField = {
  label: string
  placeholder?: string
  /** A header or variable value: masked until shown, and a saved one never reaches the phone. */
  secret?: boolean
  url?: boolean
  required?: boolean
  maxLength?: number
}

export type ToolValueProblem = { text: string; fix?: { label: string; values: string[] } }

export function MobileBotToolValuePage(props: {
  title: string
  initial: string[]
  fields: (values: string[]) => ToolValueField[]
  /** Why these values can't be kept; Done stays off while there is one. */
  problem?: (values: string[]) => ToolValueProblem | null
  remove?: { label: string; onPress: () => void }
  onCancel: () => void
  onDone: (values: string[]) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [values, setValues] = useState(props.initial)
  const [shown, setShown] = useState(false)
  const fields = props.fields(values)
  const problem = props.problem?.(values) ?? null
  const ready =
    problem === null &&
    fields.every(
      // A secret may be only spaces; a name may not.
      (field, index) => !field.required || (field.secret ? values[index] : values[index].trim())
    )
  const done = () => {
    if (ready) {
      props.onDone(values)
    }
  }
  return (
    <>
      <SheetHeader
        title={props.title}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel }}
        trailing={{ label: t('common.done', 'Done'), onPress: done, disabled: !ready }}
      />
      <View style={styles.fields}>
        {fields.map((field, index) => (
          <TextField
            key={field.label}
            label={fields.length > 1 ? field.label : undefined}
            accessibilityLabel={field.label}
            value={values[index]}
            onChangeText={(next) => setValues(values.map((v, i) => (i === index ? next : v)))}
            placeholder={field.placeholder}
            secureTextEntry={field.secret && !shown}
            keyboardType={field.url ? 'url' : undefined}
            maxLength={field.maxLength}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus={index === 0}
            returnKeyType="done"
            onSubmitEditing={done}
            trailing={
              // A saved value never reaches the phone, so only a typed one can be shown.
              field.secret && values[index] ? (
                <MobileBotTextButton
                  label={shown ? t('bots.tools.hide', 'Hide') : t('bots.tools.show', 'Show')}
                  onPress={() => setShown(!shown)}
                />
              ) : undefined
            }
          />
        ))}
      </View>
      {problem ? <SettingsNote error>{problem.text}</SettingsNote> : null}
      {problem?.fix ? (
        <SettingsSection>
          <ListRow
            title={problem.fix.label}
            onPress={() => setValues(problem.fix?.values ?? values)}
          />
        </SettingsSection>
      ) : null}
      {props.remove ? (
        <SettingsSection>
          <ListRow title={props.remove.label} destructive onPress={props.remove.onPress} />
        </SettingsSection>
      ) : null}
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  fields: { marginTop: spacing.sm, gap: spacing.sm }
}))
