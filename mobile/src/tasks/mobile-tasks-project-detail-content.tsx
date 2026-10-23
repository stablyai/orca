import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { View } from './mobile-tasks-dependencies'
import { Banner } from '../components/ui/Banner'
import { StateView } from '../components/ui/StateView'
import { detailContentStyles } from './mobile-tasks-item-detail-content'
import { renderMobileTasksProjectIssueMetadata } from './mobile-tasks-project-metadata-editors'
import { renderMobileTasksProjectReviewPanels } from './mobile-tasks-project-review-panels'
import { renderMobileTasksProjectComments } from './mobile-tasks-project-comments'

export function renderMobileTasksProjectLoadedDetail(model: ConnectionPresentationModel) {
  const { projectRowDetailError, projectRowDetailLoading } = model
  return projectRowDetailLoading ? (
    <View style={detailContentStyles.loading}>
      <StateView loading title="Loading details…" />
    </View>
  ) : projectRowDetailError ? (
    <View style={detailContentStyles.errorBanner}>
      <Banner tone="error" title="Couldn't load details" message={projectRowDetailError} />
    </View>
  ) : (
    <>
      {renderMobileTasksProjectIssueMetadata(model)}
      {renderMobileTasksProjectReviewPanels(model)}
      {renderMobileTasksProjectComments(model)}
    </>
  )
}
