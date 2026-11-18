// A template's detail on the phone, as the desktop panel shows it; Use template… prefills New bot.
import { Pressable, Text, View } from 'react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BOT_CONNECTOR_NAMES, type BotTemplate } from '../../../src/shared/bots/bot-templates'
import {
  BOT_TEMPLATE_SKILL_LINES,
  botTemplateEventParts
} from '../../../src/shared/bots/bot-template-view'
import { MobileBotAvatar } from './MobileBotAvatar'
import { useBotTemplateCategoryLabel } from './mobile-bot-template-labels'

function Part(props: { title: string; line?: string | null; state?: string; mono?: boolean }) {
  return (
    <View style={styles.part}>
      <View style={styles.partText}>
        <Text style={[styles.partTitle, props.mono && styles.mono]}>{props.title}</Text>
        {props.line ? <Text style={styles.muted}>{props.line}</Text> : null}
      </View>
      {props.state ? <Text style={styles.muted}>{props.state}</Text> : null}
    </View>
  )
}

export function MobileBotTemplateDetail(props: {
  template: BotTemplate
  visible: boolean
  onClose: () => void
  onUse: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const label = useBotTemplateCategoryLabel()
  const { template } = props
  return (
    <BottomDrawer visible={props.visible} onClose={props.onClose} contentScrollable>
      <View style={styles.head}>
        <MobileBotAvatar avatar={{ kind: 'mascot', id: template.mascot }} size={48} />
        <View style={styles.headText}>
          <Text style={styles.name}>{template.name}</Text>
          <Text style={styles.muted}>
            {t('bots.templates.byOrca', '{{category}} · by Orca', {
              category: label(template.category)
            })}
          </Text>
        </View>
      </View>
      <Text style={styles.body}>{template.line}</Text>
      <Pressable
        style={({ pressed }) => [styles.use, pressed && styles.pressed]}
        onPress={props.onUse}
        accessibilityRole="button"
      >
        <Text style={styles.useText}>{t('bots.templates.useTemplate', 'Use template…')}</Text>
      </Pressable>
      <View style={styles.example}>
        {template.example.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}
      </View>
      <Text style={styles.section}>{t('bots.templates.firstChat', 'What it does first')}</Text>
      <Text style={styles.body}>{template.firstChat}</Text>
      {template.needsSetup ? (
        <>
          <Text style={styles.section}>{t('bots.templates.needsSetup', 'Needs setup')}</Text>
          <Text style={styles.body}>{template.needsSetup}</Text>
        </>
      ) : null}
      <Text style={styles.section}>{t('bots.templates.comesWith', 'Comes with')}</Text>
      <Text style={styles.muted}>
        {t(
          'bots.templates.comesWithNote',
          'Schedules start turned off. Automations and connectors are set up in its first chat, once you pick the repo or channel.'
        )}
      </Text>
      {template.skills.map((skill) => (
        <Part key={skill} mono title={skill} line={BOT_TEMPLATE_SKILL_LINES[skill]} />
      ))}
      {template.schedules.map((schedule) => (
        <Part
          key={schedule.id}
          title={schedule.when}
          line={schedule.what}
          state={t('bots.templates.stateOff', 'Off')}
        />
      ))}
      {template.events.map((event) => {
        const parts = botTemplateEventParts(event.name)
        return (
          <Part
            key={event.id}
            title={parts.trigger}
            line={parts.action}
            state={t('bots.templates.stateFirstChat', 'First chat')}
          />
        )
      })}
      {template.connectors.map((kind) => (
        <Part
          key={kind}
          title={BOT_CONNECTOR_NAMES[kind]}
          state={t('bots.templates.stateNotConnected', 'Not connected')}
        />
      ))}
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.sm },
  headText: { flex: 1, alignItems: 'flex-start' },
  name: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  body: { fontSize: 14, color: colors.textPrimary, marginTop: spacing.xs },
  muted: { fontSize: 12, color: colors.textMuted },
  section: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: spacing.lg,
    marginBottom: spacing.xs
  },
  example: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    padding: spacing.md,
    marginTop: spacing.md
  },
  use: {
    backgroundColor: colors.textPrimary,
    borderRadius: radii.control,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.md
  },
  useText: { color: colors.bgBase, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  part: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  partText: { flex: 1 },
  partTitle: { fontSize: 14, color: colors.textPrimary },
  mono: { fontFamily: typography.monoFamily, fontSize: 13 }
}))
