import { useState } from 'react'
import { View, Text, Pressable, ScrollView, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type {
  ChimeMode,
  LinkReading,
  ProjectNameMode,
  ReadScope
} from '../storage/speech-preferences'
import { useAnnounceWaits } from './agent-wait-announcement'
import { setAutoReadMuted, useAutoReadMuted } from './auto-read-mute'
import { useAutoReadRepliesPreference } from './auto-read-preference'
import { useBackgroundReadingPreference } from './background-reading'
import { QuickSettingsTileRow } from './quick-settings-tile-row'
import { readAloudStyles as styles } from './read-aloud-settings-styles'
import {
  ReadAloudVoiceGroup,
  ReadAloudVoicePickers,
  type VoicePicker
} from './read-aloud-voice-settings'
import { useChimeMode, useProjectNameMode } from './project-name-announcement'
import { useReadScopePreference } from './read-scope-preference'
import { useHeadphonesOnly, useLinkReading } from './reading-preferences'
import { playChimeSample } from './reply-speaker'
import { describeSpeechDiagnostics, useSpeechDiagnostics } from './speech-diagnostics'
import { useSpeechOptions } from './speech-options'

const READ_SCOPES: { scope: ReadScope; label: string; sublabel: string }[] = [
  {
    scope: 'all',
    label: 'Every message',
    sublabel: 'Also what the agent writes while it is still working'
  },
  {
    scope: 'all-on-screen',
    label: 'Every message on screen, final replies off screen',
    sublabel: 'Everything while Orca is open; only the turn-ending answer with the screen off'
  },
  {
    scope: 'replies',
    label: 'Final replies only',
    sublabel: 'Only the answer that ends a turn, as in notifications'
  }
]

const PROJECT_NAME_MODES: { mode: ProjectNameMode; label: string; sublabel: string }[] = [
  {
    mode: 'on-change',
    label: 'When the project changes',
    sublabel: 'Before a message from another project, or after two quiet minutes'
  },
  {
    mode: 'every',
    label: 'Before every message',
    sublabel: 'Even when several come from one agent'
  },
  { mode: 'off', label: 'Off', sublabel: 'Only the message' }
]

const CHIME_MODES: { mode: ChimeMode; label: string; sublabel: string }[] = [
  {
    mode: 'every',
    label: 'Before every message',
    sublabel: 'Also marks where one message ends and the next begins'
  },
  {
    mode: 'on-change',
    label: 'When the project changes',
    sublabel: 'Same rule as the project name: another project, or after two quiet minutes'
  },
  { mode: 'off', label: 'Off', sublabel: 'No sound' }
]

const LINK_READINGS: { mode: LinkReading; label: string; sublabel: string }[] = [
  {
    mode: 'word-and-text',
    label: 'Say “link”, then its text',
    sublabel: '“link WHO report”; a bare address is just “link”'
  },
  {
    mode: 'word-text-site',
    label: 'Say “link”, its text and the site',
    sublabel: '“link WHO report, who.int”'
  },
  { mode: 'text', label: 'Only its text', sublabel: '“WHO report”; a bare address is “link”' },
  { mode: 'off', label: 'Skip links', sublabel: 'Neither the text nor the address' }
]

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
  const muted = useAutoReadMuted()
  const diagnostics = useSpeechDiagnostics()
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
        <Text style={styles.groupDescription}>
          Messages are read with the speed and voice set below; code blocks and tables are skipped,
          and a Stop button appears at the top while one is being read.
        </Text>

        <ReadAloudVoiceGroup state={speechOptions} onOpenPicker={setPicker} />

        <Text style={[styles.groupHeading, styles.groupGap]}>LINKS</Text>
        <Text style={styles.groupDescription}>
          How a link in a message is read, by the Read button and auto-read alike.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          {LINK_READINGS.map((option, index) => {
            const selected = option.mode === linkReading
            return (
              <Pressable
                key={option.mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={index === 0 ? styles.row : [styles.row, styles.rowDivider]}
                onPress={() => setLinkReading(option.mode)}
              >
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>{option.label}</Text>
                  <Text style={styles.rowSublabel}>{option.sublabel}</Text>
                </View>
                {selected ? <Check size={18} color={colors.textPrimary} /> : null}
              </Pressable>
            )
          })}
        </View>

        <Text style={[styles.groupHeading, styles.groupGap]}>CONTROLS</Text>
        <Text style={styles.groupDescription}>
          While a message is read, the buttons of headphones and of a car's steering wheel, and the
          reading notification, pause it and go to the next or previous message (Previous starts the
          message again; pressed twice, the one before it). Afterwards the notification's Repeat
          reads the last message again. A call or dictation pauses the reading, which goes on when
          they end.
        </Text>

        <Text style={[styles.groupHeading, styles.groupGap]}>AUTO-READ</Text>
        <Text style={styles.groupDescription}>
          New messages from every connected agent are read as they arrive, on any screen.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Auto-read new messages</Text>
              <Text style={styles.rowSublabel}>{autoRead ? 'On' : 'Off'}</Text>
            </View>
            <Switch
              accessibilityLabel="Auto-read new messages"
              value={autoRead}
              onValueChange={setAutoRead}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Mute for now</Text>
              <Text style={styles.rowSublabel}>
                {muted
                  ? 'Muted — until you unmute here, in the notification or on the tile, or restart Orca'
                  : 'Also in the reading notification and the Quick Settings tile; a restart of Orca unmutes'}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Mute auto-read for now"
              value={muted}
              onValueChange={setAutoReadMuted}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
          <QuickSettingsTileRow />
          {speechOptions.available ? (
            <View style={[styles.row, styles.rowDivider]}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>Keep reading with the screen off</Text>
                <Text style={styles.rowSublabel}>
                  {backgroundReading
                    ? 'On — while auto-read is on, a notification keeps Orca awake (uses more battery)'
                    : 'Off — auto-read stops when Orca leaves the screen'}
                </Text>
              </View>
              <Switch
                accessibilityLabel="Keep reading with the screen off"
                value={backgroundReading}
                onValueChange={setBackgroundReading}
                trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                thumbColor={colors.textPrimary}
              />
            </View>
          ) : null}
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Say when an agent waits for you</Text>
              <Text style={styles.rowSublabel}>
                {announceWaits === 'on'
                  ? 'On — a question or a permission request is said once, like a message'
                  : 'Off — a waiting agent stays quiet'}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Say when an agent waits for you"
              value={announceWaits === 'on'}
              onValueChange={(on) => setAnnounceWaits(on ? 'on' : 'off')}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
          {speechOptions.available ? (
            <View style={[styles.row, styles.rowDivider]}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>Only with headphones or a car</Text>
                <Text style={styles.rowSublabel}>
                  {headphonesOnly === 'on'
                    ? 'On — through the phone’s own speaker auto-read stays quiet; unplugging pauses it'
                    : 'Off — also through the phone’s speaker'}
                </Text>
              </View>
              <Switch
                accessibilityLabel="Auto-read only with headphones or a car"
                value={headphonesOnly === 'on'}
                onValueChange={(on) => setHeadphonesOnly(on ? 'on' : 'off')}
                trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                thumbColor={colors.textPrimary}
              />
            </View>
          ) : null}
        </View>

        <Text style={[styles.groupHeading, styles.groupGap]}>WHAT TO READ</Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          {READ_SCOPES.map((option, index) => {
            const selected = option.scope === readScope
            return (
              <Pressable
                key={option.scope}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={index === 0 ? styles.row : [styles.row, styles.rowDivider]}
                onPress={() => setReadScope(option.scope)}
              >
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>{option.label}</Text>
                  <Text style={styles.rowSublabel}>{option.sublabel}</Text>
                </View>
                {selected ? <Check size={18} color={colors.textPrimary} /> : null}
              </Pressable>
            )
          })}
        </View>

        <Text style={[styles.groupHeading, styles.groupGap]}>PROJECT NAME</Text>
        <Text style={styles.groupDescription}>
          Auto-read says the project first, so you know which agent is talking.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          {PROJECT_NAME_MODES.map((option, index) => {
            const selected = option.mode === projectNameMode
            return (
              <Pressable
                key={option.mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={index === 0 ? styles.row : [styles.row, styles.rowDivider]}
                onPress={() => setProjectNameMode(option.mode)}
              >
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>{option.label}</Text>
                  <Text style={styles.rowSublabel}>{option.sublabel}</Text>
                </View>
                {selected ? <Check size={18} color={colors.textPrimary} /> : null}
              </Pressable>
            )
          })}
        </View>

        <Text style={[styles.groupHeading, styles.groupGap]}>SOUND BEFORE A MESSAGE</Text>
        <Text style={styles.groupDescription}>
          A short chime before auto-read talks, with the project name or instead of it.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          {CHIME_MODES.map((option, index) => {
            const selected = option.mode === chimeMode
            return (
              <Pressable
                key={option.mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={index === 0 ? styles.row : [styles.row, styles.rowDivider]}
                onPress={() => {
                  setChimeMode(option.mode)
                  if (option.mode !== 'off') {
                    playChimeSample()
                  }
                }}
              >
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>{option.label}</Text>
                  <Text style={styles.rowSublabel}>{option.sublabel}</Text>
                </View>
                {selected ? <Check size={18} color={colors.textPrimary} /> : null}
              </Pressable>
            )
          })}
        </View>

        <Text style={styles.diagnostics} selectable>
          {describeSpeechDiagnostics(diagnostics)}
        </Text>
      </ScrollView>

      <ReadAloudVoicePickers
        state={speechOptions}
        picker={picker}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}
