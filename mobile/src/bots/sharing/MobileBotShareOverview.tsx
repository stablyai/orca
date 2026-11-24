// Share bot's contents and its last row: one row per part with a quiet value, then the one next
// step (Publish link, Update link or Sign in to publish). The desktop's BotShareOverview and footer.
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import {
  BookOpen,
  Brain,
  Check,
  Clock,
  Minus,
  NotebookPen,
  RefreshCw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Smile,
  TriangleAlert,
  Wrench
} from 'lucide-react-native'
import { allMemory, pickedOf } from '../../../../src/shared/bots/bot-share-pick-lists'
import {
  pickedSkillNames,
  unpackableSkills
} from '../../../../src/shared/bots/bot-share-skill-picks'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { ListRow } from '../../components/list/ListGroup'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botShareCheckSummary, botShareLines } from './bot-share-copy'
import type { useHostOrcaSignIn } from './use-host-orca-sign-in'
import type { PhoneShareLinkState } from './use-phone-bot-share-link'
import { uniqueEvents, type ShareContext, type ShareList } from './mobile-share-pages'

export type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; updated: boolean }
/** "2 of 3", or every name when all are picked. */
function partValue(
  picked: readonly string[],
  all: number,
  t: ReturnType<typeof useMobileTranslation>
) {
  return picked.length === all && all > 0
    ? picked.join(', ')
    : t('bots.share.countOf', '{{picked}} of {{all}}', { picked: picked.length, all })
}

function firstWords(note: string): string | null {
  const words = note.trim().split(/\s+/).filter(Boolean)
  return words.length === 0 ? null : `${words.slice(0, 5).join(' ')}${words.length > 5 ? '…' : ''}`
}

/** One part: icon, title, a quiet value; "None" when empty and nothing to open. */
function PartRow(props: {
  icon: ReactNode
  title: string
  value?: string
  tone?: 'secret' | 'warning'
  empty?: boolean
  accessory?: ReactNode
  onOpen?: () => void
}) {
  const t = useMobileTranslation()
  const opens = Boolean(props.onOpen) && !props.empty
  const value = props.empty ? t('bots.share.none', 'None') : props.value
  return (
    <ListRow
      leading={props.icon}
      title={props.title}
      value={props.tone ? undefined : value}
      accessory={
        <>
          {props.tone && value ? (
            <Text
              style={[styles.toned, props.tone === 'secret' ? styles.secret : styles.warning]}
              numberOfLines={1}
            >
              {value}
            </Text>
          ) : null}
          {props.accessory}
        </>
      }
      navigates={opens && !props.accessory}
      onPress={opens ? props.onOpen : undefined}
    />
  )
}

/** The candidate's parts, or the same rows waiting on it. */
export function ShareOverview(props: {
  ctx: ShareContext | null
  online: boolean
  first: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const icon = (Icon: typeof Smile, color: string = colors.textSecondary) => (
    <Icon size={18} color={color} />
  )
  const { ctx } = props
  if (!ctx) {
    return (
      <SettingsSection first={props.first}>
        <ListRow leading={icon(Smile)} title={t('bots.share.soul', 'Soul')} />
        <ListRow leading={icon(BookOpen)} title={t('bots.share.skills', 'Skills')} />
        <ListRow leading={icon(Clock)} title={t('bots.share.automations', 'Automations')} />
        <ListRow leading={icon(Wrench)} title={t('bots.share.tools', 'Tools')} />
        <ListRow
          leading={icon(Brain)}
          title={t('bots.share.includeMemory', 'Include memory')}
          accessory={<LoadingSpinner size={16} color={colors.textMuted} />}
        />
      </SettingsSection>
    )
  }
  const { candidate, selection, spots } = ctx
  const { available, leftOut } = candidate
  const list = (name: ShareList) => () => ctx.open({ kind: 'list', list: name })
  const skills = pickedSkillNames(selection.skills, available.skills, selection.outsideSkills)
  const skillsLeftOut = unpackableSkills(leftOut).length
  const events = uniqueEvents(available.eventSuggestions)
  const automationNames = [
    ...available.schedules
      .filter((s) => pickedOf(selection.schedules, [s.automationId]).length > 0)
      .map((s) => s.name),
    ...events
      .filter((e) => pickedOf(selection.eventSuggestions, [e.automationId]).length > 0)
      .map((e) => e.name)
  ]
  const webhooks = leftOut.filter((entry) => entry.kind === 'automation').length
  const automations = available.schedules.length + events.length
  const tools = pickedOf(
    selection.tools,
    available.tools.map((tool) => tool.name)
  )
  const commands = leftOut.filter(
    (entry) => entry.kind === 'tool' && entry.why === 'command'
  ).length
  const memoryOn = selection.memory !== undefined
  const memorySecret = spots.some(
    (spot) => spot.flag.kind === 'secret' && spot.part?.startsWith('memory:')
  )
  const secrets = spots.filter((spot) => spot.flag.kind === 'secret').length
  const lines = botShareLines(available.soulLines)
  const CheckIcon = secrets > 0 ? ShieldAlert : spots.length > 0 ? TriangleAlert : ShieldCheck
  return (
    <>
      <SettingsSection first={props.first}>
        <PartRow
          icon={icon(Smile)}
          title={t('bots.share.soul', 'Soul')}
          value={lines}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: 'soul',
              title: t('bots.share.soul', 'Soul'),
              detail: `SOUL.md · ${lines}`
            })
          }
        />
        <PartRow
          icon={icon(BookOpen)}
          title={t('bots.share.skills', 'Skills')}
          // Opens to show skills that can't be shared, but only shareable ones count.
          empty={available.skills.length + skillsLeftOut === 0}
          value={
            available.skills.length === 0
              ? t('bots.share.none', 'None')
              : partValue(skills, available.skills.length, t)
          }
          onOpen={list('skills')}
        />
        <PartRow
          icon={icon(Clock)}
          title={t('bots.share.automations', 'Automations')}
          empty={automations + webhooks === 0}
          value={partValue(automationNames, automations + webhooks, t)}
          onOpen={list('automations')}
        />
        <PartRow
          icon={icon(Wrench)}
          title={t('bots.share.tools', 'Tools')}
          empty={available.tools.length + commands === 0}
          value={partValue(tools, available.tools.length + commands, t)}
          onOpen={list('tools')}
        />
        <PartRow
          icon={icon(Brain)}
          title={t('bots.share.includeMemory', 'Include memory')}
          tone={memorySecret ? 'secret' : undefined}
          value={
            memoryOn
              ? t('bots.share.countOf', '{{picked}} of {{all}}', {
                  picked: selection.memory?.length ?? 0,
                  all: available.memory.length
                })
              : undefined
          }
          accessory={
            <MobileSwitch
              value={memoryOn}
              disabled={available.memory.length === 0 || !props.online}
              accessibilityLabel={t('bots.share.includeMemory', 'Include memory')}
              onValueChange={(on) => {
                // On sends every file; the list that opens is for leaving some out.
                ctx.select({ memory: on ? allMemory(available.memory) : undefined })
                if (on) {
                  ctx.open({ kind: 'list', list: 'memory' })
                }
              }}
            />
          }
          onOpen={memoryOn ? list('memory') : undefined}
        />
        {candidate.notIncluded.length > 0 ? (
          <PartRow
            icon={icon(Minus)}
            title={t('bots.share.notIncluded', 'Not included')}
            value={String(candidate.notIncluded.length)}
            onOpen={list('notIncluded')}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection>
        <PartRow
          icon={icon(NotebookPen)}
          title={t('bots.share.setupNote', 'Setup note')}
          value={firstWords(ctx.note) ?? t('bots.share.add', 'Add')}
          onOpen={list('note')}
        />
        <PartRow
          icon={icon(
            CheckIcon,
            secrets > 0
              ? colors.statusRed
              : spots.length > 0
                ? colors.statusAmber
                : colors.statusGreen
          )}
          title={t('bots.share.safetyCheck', 'Safety check')}
          tone={secrets > 0 ? 'secret' : spots.length > 0 ? 'warning' : undefined}
          value={botShareCheckSummary(spots)}
          onOpen={spots.length > 0 ? list('check') : undefined}
        />
      </SettingsSection>
    </>
  )
}

/** The flow's last row: the one next step, with the line that says why it waits. */
export function ShareFoot(props: {
  read: PhoneShareLinkState['read']
  link: { url: string } | null
  phase: Phase
  error: { message: string; moved: boolean } | null
  secret: boolean
  upToDate: boolean | null
  ready: boolean
  building: boolean
  signIn: ReturnType<typeof useHostOrcaSignIn>
  hostName: string
  onPublish: () => void
  onReload: () => void
  onDone: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { phase, link, signIn } = props
  const busy = phase.kind === 'busy'
  if (phase.kind === 'done') {
    return (
      <View style={styles.foot}>
        <SheetPrimaryButton label={t('bots.share.done', 'Done')} onPress={props.onDone} />
      </View>
    )
  }
  if (props.read.kind === 'signIn') {
    const waiting = signIn.view.phase === 'waiting'
    return (
      <View style={styles.foot}>
        {waiting ? (
          <SettingsSection>
            <ListRow
              leading={<LoadingSpinner size={18} color={colors.textSecondary} />}
              title={t('bots.share.waitingSignIn', 'Waiting for sign-in in your browser')}
              subtitle={t('bots.share.signInFor', 'Signs {{host}} in to Orca.', {
                host: props.hostName
              })}
              accessory={
                <MobileBotTextButton
                  label={t('bots.share.cancelSignIn', 'Cancel sign-in')}
                  onPress={signIn.cancel}
                />
              }
            />
          </SettingsSection>
        ) : (
          <Text style={[styles.hint, signIn.view.phase === 'failed' && styles.secret]}>
            {signIn.view.phase === 'failed'
              ? signIn.view.error || t('bots.share.signIn', 'Sign in to Orca to share.')
              : t('bots.share.signIn', 'Sign in to Orca to share.')}
          </Text>
        )}
        {waiting ? null : (
          <SheetPrimaryButton
            label={t('bots.share.signInToPublish', 'Sign in to publish')}
            icon={Share2}
            onPress={signIn.start}
          />
        )}
      </View>
    )
  }
  const message = props.secret
    ? { text: t('bots.share.removeSecret', 'Remove the secret to publish'), error: true }
    : props.error
      ? { text: props.error.message, error: true }
      : link || props.read.kind === 'loading'
        ? null
        : {
            text: t('bots.share.description', 'Anyone with the link can make a copy.'),
            error: false
          }
  const primary = link ? (
    props.error?.moved ? (
      <SheetPrimaryButton
        label={t('bots.share.reload', 'Reload')}
        icon={RefreshCw}
        onPress={props.onReload}
      />
    ) : (
      <SheetPrimaryButton
        label={
          props.upToDate
            ? t('bots.share.upToDate', 'Up to date')
            : t('bots.share.updateLink', 'Update link')
        }
        icon={props.upToDate ? Check : RefreshCw}
        disabled={!props.ready || props.upToDate === true}
        busy={busy || (props.building && !props.upToDate)}
        onPress={props.onPublish}
      />
    )
  ) : (
    <SheetPrimaryButton
      label={t('bots.share.publishLink', 'Publish link')}
      icon={Share2}
      disabled={!props.ready}
      busy={busy || props.read.kind === 'loading'}
      onPress={props.onPublish}
    />
  )
  return (
    <View style={styles.foot}>
      {message ? (
        <Text style={[styles.hint, message.error && styles.secret]}>{message.text}</Text>
      ) : null}
      {primary}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  toned: { fontSize: 15, flexShrink: 1 },
  secret: { color: colors.statusRed },
  warning: { color: colors.statusAmber },
  foot: { gap: spacing.sm, paddingTop: spacing.lg, paddingBottom: spacing.md },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center' }
}))
