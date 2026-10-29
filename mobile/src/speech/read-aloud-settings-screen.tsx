import { Fragment, useState } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import { MobileSwitch } from '../components/MobileSwitch'
import { voiceSettingsStyles as styles } from '../settings/voice-settings-styles'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type {
  ChimeMode,
  LinkReading,
  ProjectNameMode,
  ReadScope
} from '../storage/speech-preferences'
import { useAnnounceWaits } from './agent-wait-announcement'
import { setAutoReadPaused, useAutoReadPaused } from './auto-read-pause'
import { useAutoReadRepliesPreference } from './auto-read-preference'
import { useBackgroundReadingPreference } from './background-reading'
import { QuickSettingsTileRow } from './quick-settings-tile-row'
import { readAloudStyles } from './read-aloud-settings-styles'
import {
  ReadAloudVoiceGroup,
  ReadAloudVoicePickers,
  type VoicePicker
} from './read-aloud-voice-settings'
import { useChimeMode, useProjectNameMode } from './project-name-announcement'
import { useReadScopePreference } from './read-scope-preference'
import { useHeadphonesOnly, useLinkReading } from './reading-preferences'
import { playChimeSample } from './reply-speaker'
import { useSpeechOptions } from './speech-options'

type Option<T extends string> = { value: T; label: string; sublabel: string }

const READ_SCOPES: Option<ReadScope>[] = [
  {
    value: 'all',
    label: 'Every message',
    sublabel: 'Also what the agent writes while it is still working'
  },
  {
    value: 'all-on-screen',
    label: 'Every message on screen, final replies off screen',
    sublabel: 'Everything while Orca is open; only the turn-ending answer with the screen off'
  },
  {
    value: 'replies',
    label: 'Final replies only',
    sublabel: 'Only the answer that ends a turn, as in notifications'
  }
]

const PROJECT_NAME_MODES: Option<ProjectNameMode>[] = [
  {
    value: 'on-change',
    label: 'When the project changes',
    sublabel: 'Before a message from another project, or after two quiet minutes'
  },
  {
    value: 'every',
    label: 'Before every message',
    sublabel: 'Even when several come from one agent'
  },
  { value: 'off', label: 'Off', sublabel: 'Only the message' }
]

const CHIME_MODES: Option<ChimeMode>[] = [
  {
    value: 'every',
    label: 'Before every message',
    sublabel: 'Also marks where one message ends and the next begins'
  },
  {
    value: 'on-change',
    label: 'When the project changes',
    sublabel: 'Same rule as the project name: another project, or after two quiet minutes'
  },
  { value: 'off', label: 'Off', sublabel: 'No sound' }
]

const LINK_READINGS: Option<LinkReading>[] = [
  {
    value: 'word-and-text',
    label: 'Say “link”, then its text',
    sublabel: '“link WHO report”; a bare address is just “link”'
  },
  {
    value: 'word-text-site',
    label: 'Say “link”, its text and the site',
    sublabel: '“link WHO report, who.int”'
  },
  { value: 'text', label: 'Only its text', sublabel: '“WHO report”; a bare address is “link”' },
  { value: 'off', label: 'Skip links', sublabel: 'Neither the text nor the address' }
]

function OptionRows<T extends string>({
  options,
  selected,
  onSelect
}: {
  options: readonly Option<T>[]
  selected: T
  onSelect: (value: T) => void
}) {
  useMobileColorScheme()
  return (
    <View style={[styles.section, styles.sectionTopGap]} accessibilityRole="radiogroup">
      {options.map((option, index) => (
        <Fragment key={option.value}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: option.value === selected }}
            style={styles.row}
            onPress={() => onSelect(option.value)}
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{option.label}</Text>
              <Text style={styles.rowSublabel}>{option.sublabel}</Text>
            </View>
            {option.value === selected ? <Check size={18} color={colors.textPrimary} /> : null}
          </Pressable>
        </Fragment>
      ))}
    </View>
  )
}

export default function ReadAloudSettingsScreen() {
  useMobileColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { autoRead, setAutoRead } = useAutoReadRepliesPreference()
  const { backgroundReading, setBackgroundReading } = useBackgroundReadingPreference()
  const { readScope, setReadScope } = useReadScopePreference()
  const { value: projectNameMode, setValue: setProjectNameMode } = useProjectNameMode()
  const { value: chimeMode, setValue: setChimeMode } = useChimeMode()
  const { value: announceWaits, setValue: setAnnounceWaits } = useAnnounceWaits()
  const { value: headphonesOnly, setValue: setHeadphonesOnly } = useHeadphonesOnly()
  const { value: linkReading, setValue: setLinkReading } = useLinkReading()
  const autoReadPaused = useAutoReadPaused()
  const speechOptions = useSpeechOptions()
  const [picker, setPicker] = useState<VoicePicker | null>(null)

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Read aloud</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.groupHeading}>READ BUTTON</Text>
        <Text style={readAloudStyles.groupDescription}>
          Messages are read with the speed and voice set below; code blocks and tables are skipped,
          and a Stop button appears at the top while one is being read.
        </Text>

        <ReadAloudVoiceGroup state={speechOptions} onOpenPicker={setPicker} />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>LINKS</Text>
        <Text style={readAloudStyles.groupDescription}>
          How a link in a message is read, by the Read button and auto-read alike.
        </Text>
        <OptionRows options={LINK_READINGS} selected={linkReading} onSelect={setLinkReading} />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>CONTROLS</Text>
        <Text style={readAloudStyles.groupDescription}>
          While a message is read, the buttons of headphones and of a car's steering wheel, and the
          reading notification, pause it and go to the next or previous message (Previous starts the
          message again; pressed twice, the one before it). Afterwards the notification's Play reads
          the last message again. A call or dictation pauses the reading, which goes on when they
          end.
        </Text>

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>AUTO-READ</Text>
        <Text style={readAloudStyles.groupDescription}>
          New messages from every connected agent are read as they arrive, on any screen.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Auto-read new messages</Text>
              <Text style={styles.rowSublabel}>{autoRead ? 'On' : 'Off'}</Text>
            </View>
            <MobileSwitch
              accessibilityLabel="Auto-read new messages"
              value={autoRead}
              onValueChange={setAutoRead}
            />
          </View>
          <View style={styles.separator} />
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Pause auto-read</Text>
              <Text style={styles.rowSublabel}>
                {autoReadPaused
                  ? 'Paused — new messages wait for Play. Resume here, in the notification or on the tile'
                  : 'New messages wait instead of being read. Also in the notification and on the tile; restarting Orca resumes'}
              </Text>
            </View>
            <MobileSwitch
              accessibilityLabel="Pause auto-read"
              value={autoReadPaused}
              onValueChange={setAutoReadPaused}
            />
          </View>
          <QuickSettingsTileRow />
          {speechOptions.available ? (
            <>
              <View style={styles.separator} />
              <View style={styles.row}>
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>Keep reading with the screen off</Text>
                  <Text style={styles.rowSublabel}>
                    {backgroundReading
                      ? 'On — while auto-read is on, a notification keeps Orca awake (uses more battery)'
                      : 'Off — auto-read stops when Orca leaves the screen'}
                  </Text>
                </View>
                <MobileSwitch
                  accessibilityLabel="Keep reading with the screen off"
                  value={backgroundReading}
                  onValueChange={setBackgroundReading}
                />
              </View>
            </>
          ) : null}
          <View style={styles.separator} />
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Say when an agent waits for you</Text>
              <Text style={styles.rowSublabel}>
                {announceWaits === 'on'
                  ? 'On — a question or a permission request is said once, like a message'
                  : 'Off — a waiting agent stays quiet'}
              </Text>
            </View>
            <MobileSwitch
              accessibilityLabel="Say when an agent waits for you"
              value={announceWaits === 'on'}
              onValueChange={(on) => setAnnounceWaits(on ? 'on' : 'off')}
            />
          </View>
          {speechOptions.available ? (
            <>
              <View style={styles.separator} />
              <View style={styles.row}>
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>Only with headphones or a car</Text>
                  <Text style={styles.rowSublabel}>
                    {headphonesOnly === 'on'
                      ? 'On — through the phone’s own speaker auto-read stays quiet; unplugging pauses it'
                      : 'Off — also through the phone’s speaker'}
                  </Text>
                </View>
                <MobileSwitch
                  accessibilityLabel="Auto-read only with headphones or a car"
                  value={headphonesOnly === 'on'}
                  onValueChange={(on) => setHeadphonesOnly(on ? 'on' : 'off')}
                />
              </View>
            </>
          ) : null}
        </View>

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>WHAT TO READ</Text>
        <OptionRows options={READ_SCOPES} selected={readScope} onSelect={setReadScope} />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>PROJECT NAME</Text>
        <Text style={readAloudStyles.groupDescription}>
          Auto-read says the project first, so you know which agent is talking.
        </Text>
        <OptionRows
          options={PROJECT_NAME_MODES}
          selected={projectNameMode}
          onSelect={setProjectNameMode}
        />

        <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>SOUND BEFORE A MESSAGE</Text>
        <Text style={readAloudStyles.groupDescription}>
          A short chime before auto-read talks, with the project name or instead of it.
        </Text>
        <OptionRows
          options={CHIME_MODES}
          selected={chimeMode}
          onSelect={(mode) => {
            setChimeMode(mode)
            if (mode !== 'off') {
              playChimeSample()
            }
          }}
        />
      </ScrollView>

      <ReadAloudVoicePickers
        state={speechOptions}
        picker={picker}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}
