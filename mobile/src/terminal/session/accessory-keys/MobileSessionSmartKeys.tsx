import { Pressable, Text, View, type GestureResponderEvent } from 'react-native'
import type {
  AgentSmartKey,
  AgentSmartKeyName,
  AgentSmartKeySet
} from '../../../../../src/shared/terminal/input/agent-smart-keys'
import { MobileAgentIcon } from '../../../components/MobileAgentIcon'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStyles as styles } from './terminal-dock-styles'

function smartKeyWord(t: Translate, name: AgentSmartKeyName): string {
  switch (name) {
    case 'stop':
      return t('session.smartKeys.stop', 'Stop')
    case 'sendNow':
      return t('session.smartKeys.sendNow', 'Send now')
    case 'background':
      return t('session.smartKeys.background', 'Background')
    case 'mode':
      return t('session.smartKeys.mode', 'Mode')
    case 'yes':
      return t('session.smartKeys.yes', 'Yes')
    case 'always':
      return t('session.smartKeys.always', 'Always')
    case 'no':
      return t('session.smartKeys.no', 'No')
    case 'cancel':
      return t('session.smartKeys.cancel', 'Cancel')
    case 'history':
      return t('session.smartKeys.history', 'History')
    case 'rewind':
      return t('session.smartKeys.rewind', 'Rewind')
    case 'queue':
      return t('session.smartKeys.queue', 'Queue')
    case 'edit':
      return t('session.smartKeys.edit', 'Edit')
    case 'answer':
      return t('session.smartKeys.answer', 'Answer')
    case 'skip':
      return t('session.smartKeys.skip', 'Skip')
    case 'confirm':
      return t('session.smartKeys.confirm', 'Confirm')
    case 'reject':
      return t('session.smartKeys.reject', 'Reject')
  }
}

/** The agent's keys for its current state, in a capsule at the front of the key row. */
export function MobileSessionSmartKeys({
  keySet,
  disabled,
  onPressIn,
  onPress
}: {
  keySet: AgentSmartKeySet
  disabled: boolean
  onPressIn: (key: AgentSmartKey) => void
  onPress: (key: AgentSmartKey, event: GestureResponderEvent) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <>
      <View style={styles.smartGroup}>
        <MobileAgentIcon agentId={keySet.agentId} size={13} />
        {keySet.keys.map((key) => {
          const word = key.name ? smartKeyWord(t, key.name) : null
          return (
            <Pressable
              key={key.id}
              style={({ pressed }) => [
                styles.key,
                key.primary && styles.smartKeyPrimary,
                pressed && styles.keyPressed,
                disabled && styles.disabled
              ]}
              disabled={disabled}
              hitSlop={TERMINAL_KEY_HIT_SLOP}
              onPressIn={() => onPressIn(key)}
              onPress={(event) => onPress(key, event)}
              accessibilityRole="button"
              accessibilityLabel={
                word
                  ? t('session.smartKeys.keyLabel', '{{word}}, sends {{combo}}', {
                      word,
                      combo: key.combo
                    })
                  : t('session.accessoryKeys.sendKey', 'Send {{label}}', { label: key.combo })
              }
            >
              {word ? (
                <View style={styles.smartKeyStack}>
                  <Text style={[styles.smartKeyWord, key.primary && styles.smartKeyPrimaryText]}>
                    {word}
                  </Text>
                  <Text style={[styles.smartKeyCombo, key.primary && styles.smartKeyPrimaryText]}>
                    {key.combo}
                  </Text>
                </View>
              ) : (
                <Text style={styles.keyText}>{key.combo}</Text>
              )}
            </Pressable>
          )
        })}
      </View>
      <View style={styles.smartDivider} />
    </>
  )
}
