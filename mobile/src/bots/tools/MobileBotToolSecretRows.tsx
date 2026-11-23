// A tool's headers or environment variables on the phone's Edit tool page.
import { useState } from 'react'
import { View } from 'react-native'
import { Plus } from 'lucide-react-native'
import type { SecretDraft } from '../../../../src/shared/bots/bot-tool-draft'
import { createNonSecureContextUuid as createUuid } from '../../../../src/shared/identifiers/non-secure-context-uuid'
import { ListRow, SectionHeader } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'

/** Headers or environment variables: a name and a masked value per row, like BotToolSecretRows. */
export function MobileBotToolSecretRows(props: {
  kind: 'header' | 'variable'
  rows: SecretDraft[]
  editable: boolean
  onChange: (rows: SecretDraft[]) => void
}) {
  const t = useMobileTranslation()
  const { rows, kind } = props
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const update = (index: number, changes: Partial<SecretDraft>) =>
    props.onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)))
  const header = kind === 'header'
  return (
    <>
      <SectionHeader
        title={
          header ? t('bots.tools.headers', 'Headers') : t('bots.tools.env', 'Environment variables')
        }
      />
      {rows.map((row, index) => {
        const visible = shown.has(row.id)
        return (
          <View key={row.id} style={styles.secret}>
            <TextField
              value={row.key}
              onChangeText={(next) => update(index, { key: next, configured: false })}
              monospace
              maxLength={256}
              placeholder={t('bots.tools.keyPlaceholder', 'Name')}
              accessibilityLabel={
                header
                  ? t('bots.tools.headerName', 'header name {{index}}', { index: index + 1 })
                  : t('bots.tools.variableName', 'variable name {{index}}', { index: index + 1 })
              }
              autoCapitalize="none"
              autoCorrect={false}
              editable={props.editable}
              trailing={
                <MobileBotTextButton
                  label={t('bots.tools.remove', 'Remove')}
                  accessibilityLabel={
                    header
                      ? t('bots.tools.removeHeader', 'Remove header {{index}}', {
                          index: index + 1
                        })
                      : t('bots.tools.removeVariable', 'Remove variable {{index}}', {
                          index: index + 1
                        })
                  }
                  disabled={!props.editable}
                  onPress={() => props.onChange(rows.filter((_, i) => i !== index))}
                />
              }
            />
            <TextField
              value={row.value}
              onChangeText={(next) => update(index, { value: next })}
              monospace
              maxLength={4096}
              secureTextEntry={!visible}
              placeholder={
                row.configured
                  ? t('bots.tools.savedPlaceholder', 'Saved value · enter to replace')
                  : t('bots.tools.valuePlaceholder', 'Value')
              }
              accessibilityLabel={
                header
                  ? t('bots.tools.headerValue', 'header value {{index}}', { index: index + 1 })
                  : t('bots.tools.variableValue', 'variable value {{index}}', {
                      index: index + 1
                    })
              }
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              editable={props.editable}
              trailing={
                // A saved value never reaches the phone, so only a typed one can be shown.
                row.value ? (
                  <MobileBotTextButton
                    label={visible ? t('bots.tools.hide', 'Hide') : t('bots.tools.show', 'Show')}
                    onPress={() => {
                      const next = new Set(shown)
                      if (visible) {
                        next.delete(row.id)
                      } else {
                        next.add(row.id)
                      }
                      setShown(next)
                    }}
                  />
                ) : undefined
              }
            />
          </View>
        )
      })}
      <SettingsSection
        footer={t(
          'bots.tools.secretsHint',
          'Saved values stay private. Leave a saved value blank to keep it, enter a value to replace it, or remove its row to delete it.'
        )}
      >
        <ListRow
          title={
            header
              ? t('bots.tools.addHeader', 'Add header')
              : t('bots.tools.addVariable', 'Add variable')
          }
          leading={<Plus size={18} color={colors.textMuted} />}
          disabled={!props.editable}
          onPress={() =>
            props.onChange([...rows, { id: createUuid(), key: '', value: '', configured: false }])
          }
        />
      </SettingsSection>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  secret: { gap: spacing.xs, marginBottom: spacing.md }
}))
