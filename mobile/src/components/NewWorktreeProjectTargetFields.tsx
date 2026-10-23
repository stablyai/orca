import { View } from 'react-native'
import { HostKindIcon } from './HostKindIcon'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import { LIST_LEADING_INSET, ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'

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
  return (
    <>
      <View style={styles.bleed}>
        <SectionHeader title="Where" first />
      </View>
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
        <ListRow
          title="Project"
          leading={
            projectBadgeColor ? (
              <View style={[styles.repoDot, { backgroundColor: projectBadgeColor }]} />
            ) : null
          }
          value={project?.label ?? 'Choose'}
          navigates
          onPress={onOpenProject}
          accessibilityLabel={project ? `Project, ${project.label}` : 'Choose a project'}
        />
        <ListRow
          title="Run on"
          leading={<HostKindIcon hostId={runTarget?.hostId} size={18} />}
          value={runTarget?.label ?? 'Choose'}
          navigates
          // A run target belongs to a project; until one is picked there is nothing to choose.
          disabled={project === null}
          onPress={onOpenRunTarget}
          accessibilityLabel={runTarget ? `Run on, ${runTarget.label}` : 'Choose where it runs'}
        />
      </ListGroup>
    </>
  )
}
