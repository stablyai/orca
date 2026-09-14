import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { View, ActivityIndicator, colors, Text } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksProjectIssueMetadata } from './mobile-tasks-project-metadata-editors'
import { renderMobileTasksProjectReviewPanels } from './mobile-tasks-project-review-panels'
import { renderMobileTasksProjectComments } from './mobile-tasks-project-comments'

export function renderMobileTasksProjectLoadedDetail(model: ConnectionPresentationModel) {
  const { projectRowDetailError, projectRowDetailLoading } = model
  return projectRowDetailLoading ? (
    <View style={styles.detailLoading}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : projectRowDetailError ? (
    <Text style={styles.detailError}>{projectRowDetailError}</Text>
  ) : (
    <>
      {renderMobileTasksProjectIssueMetadata(model)}
      {renderMobileTasksProjectReviewPanels(model)}
      {renderMobileTasksProjectComments(model)}
    </>
  )
}
