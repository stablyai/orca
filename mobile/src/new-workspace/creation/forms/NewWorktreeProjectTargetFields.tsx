import { View } from 'react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { HostKindIcon } from '../../../components/icons/HostKindIcon'
import {
  LIST_LEADING_INSET,
  ListGroup,
  SectionHeader,
  ListRow
} from '../../../components/list/ListGroup'
import { newWorktreeFormStylesSheet } from './new-worktree-form-styles'
import { useThemedStyles } from '../../../theme/themed-styles'

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
  const styles = useThemedStyles(newWorktreeFormStylesSheet)
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
