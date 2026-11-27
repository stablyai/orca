// Settings › Skills: the desktop's BotSkillsSection. The bot's own skills, then each linked project's,
// and Link a project to pick from the host's projects. Open folder stays on the desktop.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Folder, Plus, Unlink } from 'lucide-react-native'
import { BOT_MAX_SKILL_PROJECTS } from '../../../../src/shared/bot-types'
import { BOT_AGENTS_LISTING_LINKED_SKILLS } from '../../../../src/shared/bots/bot-skill-projects'
import { MobileSearchField } from '../../components/controls/MobileSearchField'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../../components/list/ListGroup'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { hostReadClient } from '../../query/host-read-client'
import {
  SettingsEmptyRow,
  SettingsNote,
  SettingsSection
} from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botSkillsListedNote } from '../mobile-bot-sheet-copy'
import {
  botSkillHostRepos,
  botSkillProjectsScan,
  type PhoneSkillProject,
  type PhoneSkillScan
} from './bot-skills-operations'

type SkillsBot = { id: string; name: string; agent: string; skillProjects?: string[] }

type SettingsContext = {
  client: RpcClient | null
  reads: number
  online: boolean
  hostName: string
}

function skillCount(t: Translate, count: number): string {
  return t('bots.skills.count', '{{count}} skills', {
    count,
    defaultValue_one: '{{count}} skill'
  })
}

/** One scan on the bot's host, read again when the projects change and kept while a newer one reads;
 *  null until the first lands. A failed scan lists nothing, as on the desktop, and tries again with the
 *  route's next read (reconnect, foreground); a good one isn't redone per read, since scans walk folders. */
export function useBotSkillScan(
  client: RpcClient | null,
  bot: SkillsBot,
  repoIds: readonly string[] | null,
  routeReads: number
): PhoneSkillScan | null {
  const key = repoIds === null ? null : `${bot.id}\n${repoIds.join('\n')}`
  const [scan, setScan] = useState<PhoneSkillScan | null>(null)
  const [failed, setFailed] = useState(false)
  const retry = failed ? routeReads : 0
  useEffect(() => {
    if (!client || key === null) {
      return
    }
    let live = true
    const ids = key.split('\n').slice(1).filter(Boolean)
    botSkillProjectsScan
      .request(hostReadClient(client), { repoIds: ids, botId: bot.id })
      .then((reply) => botSkillProjectsScan.interpret(reply))
      .then(
        (read) => {
          if (live) {
            setScan(read)
            setFailed(false)
          }
        },
        () => {
          if (live) {
            setScan((current) => current ?? { projects: [] })
            setFailed(true)
          }
        }
      )
    return () => {
      live = false
    }
  }, [client, key, bot.id, retry])
  return scan
}

/** How many sources the Skills row counts, as the desktop's: its own skills, then each project still in Orca. */
export function botSkillSourceCount(scan: PhoneSkillScan | null): number | null {
  if (!scan) {
    return null
  }
  const own = scan.own
  const hasOwn = own ? own.skills.length + own.agentOnly.length > 0 : false
  return (hasOwn ? 1 : 0) + scan.projects.filter((project) => project.status !== 'missing').length
}

const OWN = '\0own'

type SkillSource = {
  name: string
  skills: readonly { id: string; name: string; description: string | null }[]
}

const folderIcon = (dim = false) => (
  <Folder size={18} color={dim ? colors.textMuted : colors.textPrimary} strokeWidth={2} />
)

/** A linked project: its skills open on their own page; on another host or gone, one line says so. */
function ProjectRow(props: {
  project: PhoneSkillProject
  onOpen: () => void
  guardPress: (onPress: () => void) => () => void
}) {
  const t = useMobileTranslation()
  const { project } = props
  const local = project.status === 'local'
  const count = local && project.skillsDir ? project.skills.length : 0
  return (
    <ListRow
      leading={folderIcon(!local)}
      title={project.name}
      subtitle={
        project.status === 'remote'
          ? t('bots.skills.remoteShort', 'On another host')
          : project.status === 'missing'
            ? t('bots.skills.missingShort', 'No longer in Orca')
            : count > 0
              ? skillCount(t, count)
              : t('bots.skills.none', 'No skills in this project yet')
      }
      subtitleLines={1}
      navigates={count > 0}
      onPress={count > 0 ? props.guardPress(props.onOpen) : undefined}
    />
  )
}

/** One source's skills: name over its description, as the desktop lists them. */
function SkillListPage(props: { source: SkillSource; banner: ReactNode; onBack: () => void }) {
  const t = useMobileTranslation()
  return (
    <>
      <SheetHeader
        title={props.source.name}
        subtitle={skillCount(t, props.source.skills.length)}
        onBack={{ label: t('bots.skills.back', 'Back to Skills'), onPress: props.onBack }}
      />
      {props.banner}
      <SettingsSection first>
        {props.source.skills.map((skill) => (
          <ListRow key={skill.id} title={skill.name} subtitle={skill.description ?? undefined} />
        ))}
      </SettingsSection>
    </>
  )
}

/** Settings › Skills: the scan comes from Settings, which counts it on its row. */
export function MobileBotSkillsPage(
  props: SettingsContext & {
    bot: SkillsBot
    scan: PhoneSkillScan | null
    banner: ReactNode
    save: (skillProjects: string[]) => Promise<boolean>
    onBack: () => void
  }
) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [linking, setLinking] = useState(false)
  // Which list is open, the bot's own or a project's id, so a re-read scan updates it.
  const [opened, setOpened] = useState<string | null>(null)
  // Removed but not yet saved, so a second swipe builds on the first.
  const [removed, setRemoved] = useState<readonly string[]>([])
  const { bot, scan } = props
  const linked = (bot.skillProjects ?? []).filter((id) => !removed.includes(id))
  const views = new Map(scan?.projects.map((project) => [project.repoId, project]))
  const own = scan?.own
  const ownSkills = own
    ? [...own.skills, ...own.agentOnly].map((skill) => ({ ...skill, id: skill.folder }))
    : []
  const ownName = t('bots.skills.own', '{{bot}}’s own skills', { bot: bot.name })
  const openProject = opened === null || opened === OWN ? undefined : views.get(opened)
  const source: SkillSource | null =
    opened === OWN
      ? { name: ownName, skills: ownSkills }
      : openProject
        ? {
            name: openProject.name,
            skills: openProject.skills.map((skill) => ({ ...skill, id: skill.name }))
          }
        : null
  // A list the re-read emptied or dropped shows as closed, and stops holding Back.
  const shown = source && source.skills.length > 0 ? source : null
  // Settings' own Back closes the page; this one closes Link a project or a skills list first.
  useBackClaim(
    linking || shown
      ? () => {
          setLinking(false)
          setOpened(null)
          return true
        }
      : null
  )
  if (linking) {
    return <LinkProjectPage {...props} linked={linked} onBack={() => setLinking(false)} />
  }
  if (shown) {
    return <SkillListPage source={shown} banner={props.banner} onBack={() => setOpened(null)} />
  }
  const listsSkills =
    BOT_AGENTS_LISTING_LINKED_SKILLS.includes(bot.agent) &&
    linked.some((id) => (views.get(id)?.skills.length ?? 0) > 0)
  const remove = (repoId: string) => {
    setRemoved((current) => [...current, repoId])
    // Saved, the bot's own list drops it; refused, the row comes back.
    void props
      .save(linked.filter((id) => id !== repoId))
      .then(() => setRemoved((current) => current.filter((id) => id !== repoId)))
  }
  return (
    <>
      <SheetHeader
        title={t('bots.skills.title', 'Skills')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {props.banner}
      {listsSkills ? <SettingsNote>{botSkillsListedNote(bot.agent, bot.name)}</SettingsNote> : null}
      {scan === null ? (
        <MobileStateView loading title={t('bots.skills.reading', 'Reading its skills…')} />
      ) : (
        <SettingsSection
          first
          separatorInset={LIST_LEADING_INSET}
          footer={t('bots.skills.nextChat', 'Skills load in {{bot}}’s next chat.', {
            bot: bot.name
          })}
        >
          {own ? (
            <ListRow
              key="own"
              leading={folderIcon()}
              title={ownName}
              subtitle={
                ownSkills.length > 0
                  ? skillCount(t, ownSkills.length)
                  : t('bots.skills.ownNone', 'No skills of its own yet.')
              }
              navigates={ownSkills.length > 0}
              onPress={ownSkills.length > 0 ? () => setOpened(OWN) : undefined}
            />
          ) : null}
          {linked.map((repoId) => {
            const project = views.get(repoId)
            // Just linked: it shows once the re-read lands.
            return project ? (
              <SwipeRowActions
                key={repoId}
                enabled={props.online}
                trailing={{
                  label: t('bots.skills.remove', 'Remove'),
                  accessibilityLabel: t('bots.skills.removeProject', 'Remove {{project}}', {
                    project: project.name
                  }),
                  icon: Unlink,
                  background: colors.statusRed,
                  foreground: colors.onStatusRed,
                  onPress: () => remove(repoId)
                }}
              >
                {(guardPress) => (
                  <ProjectRow
                    project={project}
                    onOpen={() => setOpened(repoId)}
                    guardPress={guardPress}
                  />
                )}
              </SwipeRowActions>
            ) : null
          })}
          <ListRow
            leading={<Plus size={18} color={colors.textPrimary} strokeWidth={2} />}
            title={t('bots.skills.link', 'Link a project')}
            disabled={!props.online}
            onPress={() => setLinking(true)}
          />
        </SettingsSection>
      )}
    </>
  )
}

/** The host's projects with check marks; each tap links or unlinks at once, as on the desktop. */
function LinkProjectPage(
  props: SettingsContext & {
    bot: SkillsBot
    linked: readonly string[]
    banner: ReactNode
    save: (skillProjects: string[]) => Promise<boolean>
    onBack: () => void
  }
) {
  const t = useMobileTranslation()
  const { client, linked } = props
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<{ id: string; displayName: string }[] | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    botSkillHostRepos
      .request(hostReadClient(client), {})
      .then((reply) => botSkillHostRepos.interpret(reply))
      .then(
        (read) => live && setRepos(read),
        () => live && setRepos([])
      )
    return () => {
      live = false
    }
  }, [client])
  // Each tap saves every pick so far; only the newest save's failure goes back to what the host has.
  const [picked, setPicked] = useState<readonly string[]>(linked)
  const confirmed = useRef(linked)
  const sent = useRef(0)
  useEffect(() => {
    confirmed.current = linked
  })
  // Linked projects the host no longer lists stay here, so they can still be unlinked.
  const unlisted = repos ? linked.filter((id) => !repos.some((repo) => repo.id === id)) : []
  const scan = useBotSkillScan(
    client,
    props.bot,
    repos ? [...repos.map((repo) => repo.id), ...unlisted] : null,
    props.reads
  )
  const views = new Map(scan?.projects.map((project) => [project.repoId, project]))
  const needle = query.trim().toLowerCase()
  const shown = [
    ...(repos ?? []),
    ...unlisted.map((id) => ({ id, displayName: views.get(id)?.name ?? id }))
  ].filter((repo) => repo.displayName.toLowerCase().includes(needle))
  const detail = (view: PhoneSkillProject | undefined) => {
    if (!view) {
      return undefined
    }
    if (view.status === 'remote') {
      return t('bots.skills.notYet', 'Not available yet')
    }
    return view.skills.length > 0
      ? skillCount(t, view.skills.length)
      : t('bots.skills.noneShort', 'No skills')
  }
  const toggle = (repoId: string) => {
    const next = picked.includes(repoId)
      ? picked.filter((id) => id !== repoId)
      : [...picked, repoId].slice(0, BOT_MAX_SKILL_PROJECTS)
    setPicked(next)
    const mine = ++sent.current
    const failed = () => mine === sent.current && setPicked(confirmed.current)
    void props.save(next).then((saved) => saved || failed())
  }
  return (
    <>
      <SheetHeader
        title={t('bots.skills.link', 'Link a project')}
        onBack={{ label: t('bots.skills.back', 'Back to Skills'), onPress: props.onBack }}
      />
      {props.banner}
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('bots.skills.search', 'Search projects')}
        style={styles.search}
      />
      {repos === null ? (
        <MobileStateView loading title={t('bots.skills.reading', 'Reading its skills…')} />
      ) : (
        <ListGroup>
          {shown.length === 0 ? (
            <SettingsEmptyRow>
              {t('bots.skills.noMatch', 'No projects match your search.')}
            </SettingsEmptyRow>
          ) : null}
          {shown.map((repo) => {
            const view = views.get(repo.id)
            const isLinked = picked.includes(repo.id)
            return (
              <ListRow
                key={repo.id}
                title={repo.displayName}
                value={detail(view)}
                selected={isLinked}
                accessibilityRole="checkbox"
                // A linked project on another host can still be unlinked.
                disabled={!props.online || (view?.status === 'remote' && !isLinked)}
                onPress={() => toggle(repo.id)}
              />
            )
          })}
        </ListGroup>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  search: { marginTop: spacing.sm, marginBottom: spacing.md }
}))
