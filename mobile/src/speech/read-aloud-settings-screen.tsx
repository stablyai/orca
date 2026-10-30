import { useState } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { voiceSettingsStyles as styles } from '../settings/voice-settings-styles'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useAnnounceWaits } from './agent-wait-announcement'
import { setAutoReadPaused, useAutoReadPaused } from './auto-read-pause'
import { useAutoReadRepliesPreference } from './auto-read-preference'
import { useBackgroundReadingPreference } from './background-reading'
import {
  chimeModes,
  linkReadings,
  projectNameModes,
  readScopes,
  tableReadings
} from './read-aloud-choices'
import { OptionRows, SwitchRow } from './read-aloud-setting-rows'
import { readAloudStyles } from './read-aloud-settings-styles'
import {
  ReadAloudVoiceGroup,
  ReadAloudVoicePickers,
  type VoicePicker
} from './read-aloud-voice-settings'
import { useChimeMode, useProjectNameMode } from './project-name-announcement'
import { useReadScopePreference } from './read-scope-preference'
import { useHeadphonesOnly, useLinkReading, useTableReading } from './reading-preferences'
import { playChimeSample } from './reply-speaker'
import { speakLinkSample, speakTableSample, useSpeechOptions } from './speech-options'

/** Every auto-read option but the switch itself, greyed out while auto-read is off. */
function AutoReadOptions({ enabled }: { enabled: boolean }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { backgroundReading, setBackgroundReading } = useBackgroundReadingPreference()
  const { readScope, setReadScope } = useReadScopePreference()
  const { value: projectNameMode, setValue: setProjectNameMode } = useProjectNameMode()
  const { value: chimeMode, setValue: setChimeMode } = useChimeMode()
  const { value: announceWaits, setValue: setAnnounceWaits } = useAnnounceWaits()
  const { value: headphonesOnly, setValue: setHeadphonesOnly } = useHeadphonesOnly()
  const autoReadPaused = useAutoReadPaused()
  const disabled = !enabled

  return (
    <View style={disabled && styles.disabled}>
      <View style={[styles.section, styles.sectionTopGap]}>
        <SwitchRow
          label={t('settings.readAloudSettingsScreen.pauseAutoRead', 'Pause auto-read')}
          sublabel={
            autoReadPaused
              ? t(
                  'settings.readAloudSettingsScreen.pauseAutoReadOn',
                  'Paused — new messages wait for Play. Resume here or in the notification'
                )
              : t(
                  'settings.readAloudSettingsScreen.pauseAutoReadOff',
                  'New messages wait instead of being read. Also in the notification; restarting Orca resumes'
                )
          }
          value={autoReadPaused}
          onValueChange={setAutoReadPaused}
          disabled={disabled}
        />
        <View style={styles.separator} />
        <SwitchRow
          label={t(
            'settings.readAloudSettingsScreen.screenOff',
            'Keep reading with the screen off'
          )}
          sublabel={
            backgroundReading
              ? t(
                  'settings.readAloudSettingsScreen.screenOffOn',
                  'On — a notification keeps Orca awake (uses more battery)'
                )
              : t(
                  'settings.readAloudSettingsScreen.screenOffOff',
                  'Off — auto-read stops when Orca leaves the screen'
                )
          }
          value={backgroundReading}
          onValueChange={setBackgroundReading}
          disabled={disabled}
        />
        <View style={styles.separator} />
        <SwitchRow
          label={t(
            'settings.readAloudSettingsScreen.announceWaits',
            'Say when an agent waits for you'
          )}
          sublabel={
            announceWaits === 'on'
              ? t(
                  'settings.readAloudSettingsScreen.announceWaitsOn',
                  'On — a question or a permission request is said once, like a message'
                )
              : t(
                  'settings.readAloudSettingsScreen.announceWaitsOff',
                  'Off — a waiting agent stays quiet'
                )
          }
          value={announceWaits === 'on'}
          onValueChange={(on) => setAnnounceWaits(on ? 'on' : 'off')}
          disabled={disabled}
        />
        <View style={styles.separator} />
        <SwitchRow
          label={t(
            'settings.readAloudSettingsScreen.headphonesOnly',
            'Only with headphones or a car'
          )}
          accessibilityLabel={t(
            'settings.readAloudSettingsScreen.headphonesOnlyAccessibility',
            'Auto-read only with headphones or a car'
          )}
          sublabel={
            headphonesOnly === 'on'
              ? t(
                  'settings.readAloudSettingsScreen.headphonesOnlyOn',
                  'On — through the phone’s own speaker auto-read stays quiet; unplugging pauses it'
                )
              : t(
                  'settings.readAloudSettingsScreen.headphonesOnlyOff',
                  'Off — also through the phone’s speaker'
                )
          }
          value={headphonesOnly === 'on'}
          onValueChange={(on) => setHeadphonesOnly(on ? 'on' : 'off')}
          disabled={disabled}
        />
      </View>

      <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
        {t('settings.readAloudSettingsScreen.whatToReadHeading', 'WHAT TO READ')}
      </Text>
      <OptionRows
        options={readScopes(t)}
        selected={readScope}
        onSelect={setReadScope}
        disabled={disabled}
      />

      <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
        {t('settings.readAloudSettingsScreen.projectNameHeading', 'PROJECT NAME')}
      </Text>
      <Text style={readAloudStyles.groupDescription}>
        {t(
          'settings.readAloudSettingsScreen.projectNameDescription',
          'Auto-read says the project first, so you know which agent is talking.'
        )}
      </Text>
      <OptionRows
        options={projectNameModes(t)}
        selected={projectNameMode}
        onSelect={setProjectNameMode}
        disabled={disabled}
      />

      <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
        {t('settings.readAloudSettingsScreen.chimeHeading', 'SOUND BEFORE A MESSAGE')}
      </Text>
      <Text style={readAloudStyles.groupDescription}>
        {t(
          'settings.readAloudSettingsScreen.chimeDescription',
          'A short chime before auto-read talks, with the project name or instead of it.'
        )}
      </Text>
      <OptionRows
        options={chimeModes(t)}
        selected={chimeMode}
        disabled={disabled}
        onSelect={(mode) => {
          setChimeMode(mode)
          if (mode !== 'off') {
            playChimeSample()
          }
        }}
      />
    </View>
  )
}

export default function ReadAloudSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { autoRead, setAutoRead } = useAutoReadRepliesPreference()
  const { value: linkReading, setValue: setLinkReading } = useLinkReading()
  const { value: tableReading, setValue: setTableReading } = useTableReading()
  const speechOptions = useSpeechOptions()
  const [picker, setPicker] = useState<VoicePicker | null>(null)

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>
          {t('settings.readAloudSettingsScreen.title', 'Read aloud')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.groupHeading}>
          {t('settings.readAloudSettingsScreen.readButtonHeading', 'READ BUTTON')}
        </Text>
        <Text style={readAloudStyles.groupDescription}>
          {t(
            'settings.readAloudSettingsScreen.readButtonDescription',
            'Messages are read with the voice, links and tables set below; code blocks are skipped, and a Stop button appears at the top while one is being read.'
          )}
        </Text>

        <ReadAloudVoiceGroup state={speechOptions} onOpenPicker={setPicker} />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
          {t('settings.readAloudSettingsScreen.linksHeading', 'LINKS')}
        </Text>
        <Text style={readAloudStyles.groupDescription}>
          {t(
            'settings.readAloudSettingsScreen.linksDescription',
            'Tap an option to hear it. The examples show how “Here is the source: WHO report” is read when “WHO report” links to who.int. An address without its own text is read as “link”.'
          )}
        </Text>
        <OptionRows
          options={linkReadings(t)}
          selected={linkReading}
          onSelect={(mode) => {
            setLinkReading(mode)
            speakLinkSample(mode)
          }}
        />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
          {t('settings.readAloudSettingsScreen.tablesHeading', 'TABLES')}
        </Text>
        <Text style={readAloudStyles.groupDescription}>
          {t(
            'settings.readAloudSettingsScreen.tablesDescription',
            'Tap an option to hear it. The examples are for a table with the columns Day and Run.'
          )}
        </Text>
        <OptionRows
          options={tableReadings(t)}
          selected={tableReading}
          onSelect={(mode) => {
            setTableReading(mode)
            speakTableSample(mode)
          }}
        />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>
          {t('settings.readAloudSettingsScreen.autoReadHeading', 'AUTO-READ')}
        </Text>
        <Text style={readAloudStyles.groupDescription}>
          {t(
            'settings.readAloudSettingsScreen.autoReadDescription',
            'New messages from every connected agent are read as they arrive, on any screen.'
          )}
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <SwitchRow
            label={t('settings.readAloudSettingsScreen.autoRead', 'Auto-read new messages')}
            sublabel={
              autoRead
                ? t('settings.readAloudSettingsScreen.autoReadOn', 'On')
                : t(
                    'settings.readAloudSettingsScreen.autoReadOff',
                    'Off — the options below wait until it is on'
                  )
            }
            value={autoRead}
            onValueChange={setAutoRead}
          />
        </View>
        <AutoReadOptions enabled={autoRead} />
      </ScrollView>

      <ReadAloudVoicePickers
        state={speechOptions}
        picker={picker}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}
