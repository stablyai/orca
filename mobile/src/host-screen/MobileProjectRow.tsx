import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import {
  projectPrimarySession,
  type MobileProject,
  type ProjectSession
} from './mobile-project-navigation'
import { projectListStyles as styles } from './mobile-project-list-styles'
import type { HostScreenController } from './use-host-screen-controller'

function ProjectSessionRow({
  session,
  project,
  onOpen
}: {
  session: ProjectSession
  project: MobileProject
  onOpen: HostScreenController['actions']['openWorktreeSession']
}) {
  useMobileTranslation()
  const hint = [session.status, session.agent].filter(Boolean).join(' · ')
  return (
    <Pressable
      style={styles.session}
      accessibilityRole="button"
      accessibilityLabel={session.title}
      {...(hint ? { accessibilityHint: hint } : {})}
      onPress={() => onOpen(project.worktree, session.paneKey)}
    >
      <Text style={styles.sessionTitle} numberOfLines={2}>
        {session.task === project.title ? session.role : `${session.task} · ${session.role}`}
      </Text>
      <Text style={[styles.meta, session.attention && styles.attention]}>
        {session.status}
        {session.agent ? ` · ${session.agent}` : ''}
      </Text>
    </Pressable>
  )
}

export function MobileProjectRow({
  project,
  onOpen
}: {
  project: MobileProject
  onOpen: HostScreenController['actions']['openWorktreeSession']
}) {
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState(false)
  const primary = projectPrimarySession(project)
  const current = project.sessions.filter((s) => !s.archived)
  const archived = project.sessions.filter((s) => s.archived)
  const owners = current.filter((s) => s.owner)
  const attention = current.filter((s) => s.attention).length
  const working = current.filter((s) => s.working).length
  const summary = [
    primary
      ? primary.role
      : owners.length > 1
        ? t('hostScreen.projectNavigation.owners', 'Owners: {{total}}', { total: owners.length })
        : current.length
          ? t('hostScreen.projectNavigation.chats', 'Chats: {{total}}', { total: current.length })
          : t('hostScreen.projectNavigation.open', 'Open workspace'),
    attention
      ? t('hostScreen.projectNavigation.attentionCount', 'Needs attention: {{total}}', {
          total: attention
        })
      : working
        ? t('hostScreen.projectNavigation.workingCount', 'Working: {{total}}', { total: working })
        : primary?.status,
    project.worktree.unread ? t('hostScreen.projectNavigation.unread', 'Unread') : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const hint = [summary, project.worktree.hostContextLabel].filter(Boolean).join(' · ')
  return (
    <View style={styles.row}>
      <View style={styles.project}>
        <Pressable
          style={styles.open}
          accessibilityRole="button"
          accessibilityLabel={project.worktree.displayName}
          {...(hint ? { accessibilityHint: hint } : {})}
          onPress={() =>
            primary
              ? onOpen(project.worktree, primary.paneKey)
              : current.length
                ? setExpanded(!expanded)
                : onOpen(project.worktree)
          }
        >
          <Text style={styles.title} numberOfLines={2}>
            {project.title}
          </Text>
          <Text style={[styles.meta, attention > 0 && styles.attention]} numberOfLines={2}>
            {summary}
          </Text>
          {project.worktree.hostContextLabel && (
            <Text style={styles.meta}>{project.worktree.hostContextLabel}</Text>
          )}
        </Pressable>
        <Pressable
          style={styles.expand}
          accessibilityRole="button"
          accessibilityLabel={t('hostScreen.projectNavigation.expand', '{{project}} sessions', {
            project: project.title
          })}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown size={18} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={18} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>
      {expanded && (
        <View style={styles.sessions}>
          {current.map((session) => (
            <ProjectSessionRow
              key={session.id}
              session={session}
              project={project}
              onOpen={onOpen}
            />
          ))}
          <Pressable
            style={styles.quiet}
            accessibilityRole="button"
            onPress={() => onOpen(project.worktree)}
          >
            <Text style={styles.quietText}>
              {t('hostScreen.projectNavigation.openAll', 'Open all chats and files')}
            </Text>
          </Pressable>
          {archived.length > 0 && (
            <>
              <Pressable
                style={styles.quiet}
                accessibilityRole="button"
                accessibilityLabel={t(
                  'hostScreen.projectNavigation.history',
                  '{{project}} history',
                  { project: project.title }
                )}
                accessibilityState={{ expanded: history }}
                onPress={() => setHistory(!history)}
              >
                <Text style={styles.quietText}>
                  {t('hostScreen.projectNavigation.historyCount', 'History: {{total}}', {
                    total: archived.length
                  })}
                </Text>
              </Pressable>
              {history &&
                archived.map((session) => (
                  <ProjectSessionRow
                    key={session.id}
                    session={session}
                    project={project}
                    onOpen={onOpen}
                  />
                ))}
            </>
          )}
        </View>
      )}
    </View>
  )
}
