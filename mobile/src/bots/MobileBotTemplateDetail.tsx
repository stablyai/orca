// A template's detail on the phone, as the desktop panel shows it; Use template… prefills New bot.
import { Text, View } from 'react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { LIST_ROW_PADDING, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BOT_CONNECTOR_NAMES, type BotTemplate } from '../../../src/shared/bots/bot-templates'
import {
  BOT_TEMPLATE_SKILL_LINES,
  botTemplateEventParts
} from '../../../src/shared/bots/bot-template-view'
import { MobileBotAvatar } from './MobileBotAvatar'
import { useBotTemplateCategoryLabel } from './mobile-bot-template-labels'

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
      <SheetHeader
        title={template.name}
        subtitle={t('bots.templates.byOrca', '{{category}} · by Orca', {
          category: label(template.category)
        })}
        onClose={props.onClose}
      />
      <View style={styles.picture}>
        <MobileBotAvatar avatar={{ kind: 'mascot', id: template.mascot }} size={56} />
      </View>
      <Text style={[styles.body, styles.line]}>{template.line}</Text>
      <View style={styles.use}>
        <SheetPrimaryButton
          label={t('bots.templates.useTemplate', 'Use template…')}
          onPress={props.onUse}
        />
      </View>
      <View style={styles.example}>
        {template.example.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}
      </View>
      <SectionHeader title={t('bots.templates.firstChat', 'What it does first')} />
      <Text style={[styles.body, styles.inset]}>{template.firstChat}</Text>
      {template.needsSetup ? (
        <>
          <SectionHeader title={t('bots.templates.needsSetup', 'Needs setup')} />
          <Text style={[styles.body, styles.inset]}>{template.needsSetup}</Text>
        </>
      ) : null}
      <SectionHeader title={t('bots.templates.comesWith', 'Comes with')} />
      <ListGroup>
        {template.skills.map((skill) => (
          <ListRow
            key={`skill:${skill}`}
            title={skill}
            subtitle={BOT_TEMPLATE_SKILL_LINES[skill]}
            subtitleLines={0}
          />
        ))}
        {template.schedules.map((schedule) => (
          <ListRow
            key={`schedule:${schedule.id}`}
            title={schedule.when}
            wrapTitle
            subtitle={schedule.what}
            subtitleLines={0}
            value={t('bots.templates.stateOff', 'Off')}
          />
        ))}
        {template.events.map((event) => {
          const parts = botTemplateEventParts(event.name)
          return (
            <ListRow
              key={`event:${event.id}`}
              title={parts.trigger}
              wrapTitle
              {...(parts.action ? { subtitle: parts.action } : {})}
              value={t('bots.templates.stateFirstChat', 'First chat')}
            />
          )
        })}
        {template.connectors.map((kind) => (
          <ListRow
            key={`connector:${kind}`}
            title={BOT_CONNECTOR_NAMES[kind]}
            value={t('bots.templates.stateNotConnected', 'Not connected')}
          />
        ))}
      </ListGroup>
      <Text style={[styles.note, styles.inset]}>
        {t(
          'bots.templates.comesWithNote',
          'Schedules start turned off. Automations and connectors are set up in its first chat, once you pick the repo or channel.'
        )}
      </Text>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  picture: { alignItems: 'center', paddingBottom: spacing.sm },
  body: { fontSize: 14, color: colors.textPrimary, marginTop: spacing.xs },
  line: { textAlign: 'center' },
  inset: { paddingHorizontal: LIST_ROW_PADDING },
  note: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm },
  example: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.md,
    marginTop: spacing.md
  },
  use: { marginTop: spacing.md }
}))
