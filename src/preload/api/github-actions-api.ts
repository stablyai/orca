import type {
  ActionsArtifact,
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery,
  ActionsArtifactTransferQuery,
  ActionsArtifactTransfer,
  ActionsArtifactChunk
} from '../../shared/github/actions-artifact-types'
import type {
  ActionsRequestContext,
  ActionsRunsQuery,
  ActionsWorkflowsQuery,
  ActionsDetailsQuery,
  ActionsPage,
  ActionsRun,
  ActionsWorkflow,
  ActionsRunDetails
} from '../../shared/github/actions-types'
export type GithubActionsApi = {
  actionsArtifacts: (
    args: ActionsRequestContext & ActionsArtifactsQuery
  ) => Promise<ActionsPage<ActionsArtifact>>
  startActionsArtifactDownload: (
    args: ActionsRequestContext & ActionsArtifactDownloadQuery
  ) => Promise<ActionsArtifactTransfer>
  readActionsArtifactChunk: (
    args: ActionsRequestContext & ActionsArtifactTransferQuery
  ) => Promise<ActionsArtifactChunk>
  releaseActionsArtifactDownload: (
    args: ActionsRequestContext & ActionsArtifactTransferQuery
  ) => Promise<void>
  actionsRuns: (args: ActionsRequestContext & ActionsRunsQuery) => Promise<ActionsPage<ActionsRun>>
  actionsWorkflows: (
    args: ActionsRequestContext & ActionsWorkflowsQuery
  ) => Promise<ActionsPage<ActionsWorkflow>>
  actionsRunDetails: (
    args: ActionsRequestContext & ActionsDetailsQuery
  ) => Promise<ActionsRunDetails>
}
