import { ArrowUp } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ORCA_CLOUD_DEFAULT_AGENT } from '../../../src/shared/hosted-sandbox/orca-cloud-image-agents'
import { CloudAgentPicker } from './CloudAgentPicker'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/** One card: the agent, the prompt, and Send. The send button keeps its shape in every state; when
 *  asleep its label and the caption say that sending also wakes the sandbox. */
export function CloudPromptComposer(props: {
  awake: boolean
  /** Waking now: a prompt sent goes out as soon as it is awake. */
  waking: boolean
  /** Creating or archived: typing is fine, sending waits. */
  disabled: boolean
  onSend: (text: string, agent: string) => Promise<boolean>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [draft, setDraft] = useState('')
  const [agent, setAgent] = useState(ORCA_CLOUD_DEFAULT_AGENT)
  const canSend = draft.trim() !== '' && !props.disabled
  const send = async () => {
    if (canSend && (await props.onSend(draft.trim(), agent))) {
      setDraft('')
    }
  }
  const asleep = !props.awake && !props.waking
  return (
    <View>
      <View style={styles.composerCard}>
        <CloudAgentPicker value={agent} onChange={setAgent} />
        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder={t('cloud.prompt.placeholder', 'Describe the task')}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={t('cloud.prompt.label', 'Prompt')}
            maxLength={20_000}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              asleep ? t('cloud.prompt.wakeSend', 'Wake and send') : t('cloud.prompt.send', 'Send')
            }
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => void send()}
            hitSlop={6}
            style={({ pressed }) => [
              styles.sendButton,
              !canSend && styles.sendDisabled,
              pressed && styles.pressed
            ]}
          >
            <ArrowUp
              size={18}
              color={canSend ? colors.bgBase : colors.textMuted}
              strokeWidth={2.4}
            />
          </Pressable>
        </View>
      </View>
      {props.awake ? null : (
        <Text style={styles.caption}>
          {props.waking
            ? t('cloud.prompt.wakingCaption', 'Sends when it’s awake.')
            : t('cloud.prompt.wakeCaption', 'Sending wakes the sandbox first.')}
        </Text>
      )}
    </View>
  )
}
