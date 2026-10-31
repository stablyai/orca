import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { HostKindIcon } from './HostKindIcon'
import { LIST_LEADING_INSET, ListGroup } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { SectionHeader } from './list/SectionHeader'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'

type Selection = { label: string; detail?: string }

/** The form's "Where" group: which project, and which host it runs on. */
export function NewWorktreeProjectTargetFields({
  project,
  runTarget,
  projectBadgeColor,
  onOpenProject,
  onOpenRunTarget
}: {
  project: Selection | null
  runTarget: (Selection & { hostId: string }) | null
  projectBadgeColor: string | null
  onOpenProject: () => void
  onOpenRunTarget: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const projectTitle = t('components.newWorktreeProjectTargetFields.project', 'Project')
  const runOnTitle = t('components.newWorktreeProjectTargetFields.runOn', 'Run on')
  const projectValue =
    project?.label ??
    t('components.newWorktreeProjectTargetFields.selectProject', 'Select a project')
  const runTargetValue =
    runTarget?.label ??
    t('components.newWorktreeProjectTargetFields.selectRunTarget', 'Select a run target')
  return (
    <>
      <SectionHeader title={t('components.newWorktreeProjectTargetFields.where', 'Where')} first />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        <ListRow
          key="project"
          title={projectTitle}
          leading={
            projectBadgeColor ? (
              <View style={[styles.repoDot, { backgroundColor: projectBadgeColor }]} />
            ) : null
          }
          value={projectValue}
          navigates
          onPress={onOpenProject}
          accessibilityLabel={`${projectTitle}, ${projectValue}`}
        />
        <ListRow
          key="runTarget"
          title={runOnTitle}
          leading={<HostKindIcon hostId={runTarget?.hostId} size={18} />}
          value={runTargetValue}
          navigates
          // A run target belongs to a project; until one is picked there is nothing to choose.
          disabled={project === null}
          onPress={onOpenRunTarget}
          accessibilityLabel={`${runOnTitle}, ${runTargetValue}`}
        />
      </ListGroup>
    </>
  )
}
