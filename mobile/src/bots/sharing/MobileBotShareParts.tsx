// Share bot's part pages on the phone: each part's items, ticked by default, and each item's exact
// text as it goes out. The desktop's BotShareLists, BotShareFlagPages and BotSharePartView.
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Check, Eye } from 'lucide-react-native'
import { BOT_SHARE_MAX_PICKS } from '../../../../src/shared/rpc-contract/bots-share-params'
import { allMemory, pickedOf, toggled } from '../../../../src/shared/bots/bot-share-pick-lists'
import {
  pickedSkillNames,
  toggledOutside,
  unpackableSkills
} from '../../../../src/shared/bots/bot-share-skill-picks'
import { TextField } from '../../components/composer-input/TextField'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { botShareFlagLabel, botShareLines } from './bot-share-copy'
import { FlagLine, FlagRow } from './MobileBotShareFiles'
import {
  notShared,
  eventWhen,
  scheduleWhen,
  shareFlagPage,
  uniqueEvents,
  type ShareContext,
  type ShareList
} from './mobile-share-pages'

/** The desktop's tick: a check square that is on, off, or can't be picked. */
function ShareTick(props: { on: boolean }) {
  useMobileColorScheme()
  return (
    <View style={[styles.tick, props.on && styles.tickOn]}>
      {props.on ? <Check size={13} color={colors.bgBase} strokeWidth={3} /> : null}
    </View>
  )
}

/** One item of a part: its tick (the row toggles it) and, when it has text, an eye to read it. */
export function ShareTickRow(props: {
  title: string
  subtitle?: string
  subtitleMono?: boolean
  detail?: ReactNode
  on: boolean
  disabled?: boolean
  onToggle?: (on: boolean) => void
  onPreview?: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ListRow
      leading={<ShareTick on={props.on} />}
      title={props.title}
      subtitle={props.subtitle}
      subtitleMono={props.subtitleMono}
      subtitleLines={1}
      detail={props.detail}
      disabled={props.disabled || !props.onToggle}
      accessibilityRole="checkbox"
      checked={props.on}
      onPress={props.onToggle ? () => props.onToggle?.(!props.on) : undefined}
      accessory={
        props.onPreview ? (
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('bots.share.previewFile', 'Preview {{name}}', {
              name: props.title
            })}
            onPress={props.onPreview}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Eye size={18} color={colors.textMuted} />
          </Pressable>
        ) : undefined
      }
    />
  )
}

function SkillsList({ ctx }: { ctx: ShareContext }) {
  const t = useMobileTranslation()
  const all = ctx.candidate.available.skills
  const duplicates = ctx.candidate.leftOut.filter(
    (entry) => entry.kind === 'skill' && entry.why === 'duplicate'
  )
  const unpackable = unpackableSkills(ctx.candidate.leftOut)
  const picked = pickedSkillNames(ctx.selection.skills, all, ctx.selection.outsideSkills)
  return (
    <SettingsSection first>
      {all.map((skill) => (
        <ShareTickRow
          key={skill.name}
          title={skill.name}
          subtitle={
            skill.optInFrom !== undefined
              ? skill.description
                ? t('bots.share.outsideSkillWith', 'From outside {{project}} · {{description}}', {
                    project: skill.optInFrom,
                    description: skill.description
                  })
                : t('bots.share.outsideSkill', 'From outside {{project}}', {
                    project: skill.optInFrom
                  })
              : skill.description || undefined
          }
          on={picked.includes(skill.name)}
          onToggle={(on) =>
            ctx.select({
              skills: toggled(picked, skill.name, on),
              // A skill linked in from outside its project goes only with its own tick.
              ...(skill.optInKey === undefined
                ? {}
                : {
                    outsideSkills: toggledOutside(
                      ctx.selection.outsideSkills ?? [],
                      { name: skill.name, optInKey: skill.optInKey },
                      on
                    )
                  })
            })
          }
          onPreview={() =>
            ctx.open({
              kind: 'part',
              part: `skill:${skill.name}`,
              title: skill.name,
              showNames: true
            })
          }
        />
      ))}
      {duplicates.map((entry) => (
        <ShareTickRow
          key={`left:${entry.from ?? entry.name}`}
          title={entry.name}
          subtitle={t('bots.share.duplicateSkill', 'Same name, in {{folder}} · not shared', {
            folder: entry.from ?? ''
          })}
          on={false}
        />
      ))}
      {unpackable.map((entry) => (
        <ShareTickRow
          key={`unpackable:${entry.name}`}
          title={entry.name}
          subtitle={notShared(entry.why, t)}
          on={false}
        />
      ))}
    </SettingsSection>
  )
}

function AutomationsList({ ctx }: { ctx: ShareContext }) {
  const t = useMobileTranslation()
  const { schedules, eventSuggestions } = ctx.candidate.available
  const pickedSchedules = pickedOf(
    ctx.selection.schedules,
    schedules.map((s) => s.automationId)
  )
  const events = uniqueEvents(eventSuggestions)
  const pickedEvents = pickedOf(
    ctx.selection.eventSuggestions,
    events.map((e) => e.automationId)
  )
  const webhooks = ctx.candidate.leftOut.filter((entry) => entry.kind === 'automation')
  return (
    <SettingsSection first>
      {schedules.map((schedule) => {
        const when = scheduleWhen(schedule.rrule)
        return (
          <ShareTickRow
            key={schedule.automationId}
            title={schedule.name}
            subtitle={when}
            on={pickedSchedules.includes(schedule.automationId)}
            onToggle={(on) =>
              ctx.select({ schedules: toggled(pickedSchedules, schedule.automationId, on) })
            }
            onPreview={() =>
              ctx.open({
                kind: 'part',
                part: `schedule:${schedule.automationId}`,
                title: schedule.name,
                detail: when
              })
            }
          />
        )
      })}
      {events.map((event) => {
        const when = eventWhen(event.source, event.event)
        return (
          <ShareTickRow
            key={event.automationId}
            title={event.name}
            subtitle={when}
            on={pickedEvents.includes(event.automationId)}
            onToggle={(on) =>
              ctx.select({ eventSuggestions: toggled(pickedEvents, event.automationId, on) })
            }
            onPreview={() =>
              ctx.open({
                kind: 'part',
                part: `event:${event.automationId}`,
                title: event.name,
                detail: when
              })
            }
          />
        )
      })}
      {webhooks.map((entry) => (
        <ShareTickRow
          key={`left:${entry.name}`}
          title={entry.name}
          subtitle={notShared(entry.why, t)}
          on={false}
        />
      ))}
    </SettingsSection>
  )
}

function ToolsList({ ctx }: { ctx: ShareContext }) {
  const t = useMobileTranslation()
  const all = ctx.candidate.available.tools
  const picked = pickedOf(
    ctx.selection.tools,
    all.map((tool) => tool.name)
  )
  const left = ctx.candidate.leftOut.filter(
    (entry) => entry.kind === 'tool' && entry.why === 'command'
  )
  return (
    <SettingsSection first>
      {all.map((tool) => (
        <ShareTickRow
          key={tool.name}
          title={tool.name}
          subtitle={tool.url}
          subtitleMono
          on={picked.includes(tool.name)}
          onToggle={(on) => ctx.select({ tools: toggled(picked, tool.name, on) })}
          onPreview={() => ctx.open({ kind: 'part', part: `tool:${tool.name}`, title: tool.name })}
        />
      ))}
      {left.map((entry) => (
        <ShareTickRow
          key={`left:${entry.name}`}
          title={entry.name}
          subtitle={notShared(entry.why, t)}
          on={false}
        />
      ))}
    </SettingsSection>
  )
}

function MemoryList({ ctx }: { ctx: ShareContext }) {
  const t = useMobileTranslation()
  const notes = ctx.candidate.available.memory
  const picked = ctx.selection.memory ?? []
  // On only when every file that can go out does; past BOT_SHARE_MAX_PICKS, All means the first ones.
  const most = allMemory(notes)
  const allPicked = most.length > 0 && most.every((topic) => picked.includes(topic))
  const full = picked.length >= BOT_SHARE_MAX_PICKS
  const total = notes.reduce((sum, note) => sum + note.lines, 0)
  return (
    <SettingsSection first>
      <ShareTickRow
        key="all"
        title={t('bots.share.all', 'All')}
        subtitle={
          notes.length > BOT_SHARE_MAX_PICKS
            ? t('bots.share.memoryLimit', 'Up to {{count}} files', { count: BOT_SHARE_MAX_PICKS })
            : botShareLines(total)
        }
        on={allPicked}
        onToggle={(on) => ctx.select({ memory: on ? most : [] })}
      />
      {notes.map((note) => {
        const spots = ctx.spots.filter((spot) => spot.part === `memory:${note.topic}`)
        const [flag] = spots
        const on = picked.includes(note.topic)
        return (
          <ShareTickRow
            key={note.topic}
            title={note.topic}
            subtitle={flag ? undefined : botShareLines(note.lines)}
            detail={
              flag ? (
                <FlagLine secret={spots.some((spot) => spot.flag.kind === 'secret')}>
                  {t('bots.share.flagOnLine', '{{flag}} on line {{line}}', {
                    flag: botShareFlagLabel(flag.flag.kind),
                    line: flag.flag.line ?? 1
                  })}
                </FlagLine>
              ) : undefined
            }
            on={on}
            disabled={full && !on}
            onToggle={(next) => ctx.select({ memory: toggled(picked, note.topic, next) })}
            onPreview={() =>
              ctx.open({
                kind: 'part',
                part: `memory:${note.topic}`,
                title: note.topic,
                detail: t('bots.share.memory', 'Memory')
              })
            }
          />
        )
      })}
    </SettingsSection>
  )
}

export function ShareListPage({ list, ctx }: { list: ShareList; ctx: ShareContext }) {
  const t = useMobileTranslation()
  switch (list) {
    case 'skills':
      return <SkillsList ctx={ctx} />
    case 'automations':
      return <AutomationsList ctx={ctx} />
    case 'tools':
      return <ToolsList ctx={ctx} />
    case 'memory':
      return <MemoryList ctx={ctx} />
    case 'check':
      return (
        <SettingsSection first>
          {ctx.spots.map((spot) => {
            const page = shareFlagPage(spot, t)
            return (
              <FlagRow
                key={`${spot.flag.where}:${spot.flag.line}:${spot.flag.kind}`}
                spot={spot}
                onOpen={page ? () => ctx.open(page) : null}
              />
            )
          })}
        </SettingsSection>
      )
    case 'notIncluded':
      return (
        <SettingsSection first>
          {ctx.candidate.notIncluded.map((entry) => (
            <ListRow
              key={entry}
              title={entry}
              subtitle={t('bots.share.review.notIncluded', 'Not included')}
            />
          ))}
        </SettingsSection>
      )
    case 'note':
      return (
        <View style={styles.note}>
          <TextField
            value={ctx.note}
            onChangeText={ctx.setNote}
            multiline
            maxLength={2000}
            autoFocus
            accessibilityLabel={t('bots.share.setupNote', 'Setup note')}
          />
        </View>
      )
  }
}

const styles = themedStyleSheet(() => ({
  tick: {
    width: 22,
    height: 22,
    borderRadius: radii.mark + 2,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tickOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  pressed: { opacity: 0.6 },
  note: { paddingTop: spacing.sm }
}))
