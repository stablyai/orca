import type {
  ExternalTask,
  ExternalTaskDetail,
  ExternalTaskListArgs,
  ExternalTaskDetailArgs,
  ExternalTaskEditOptions,
  ExternalTaskProvider,
  ExternalTaskProviderStatus,
  ExternalTaskUpdateArgs
} from '../../shared/external-task-types'

export type ExternalTaskApi = {
  status: (provider: ExternalTaskProvider) => Promise<ExternalTaskProviderStatus>
  list: (args: ExternalTaskListArgs) => Promise<ExternalTask[]>
  detail: (args: ExternalTaskDetailArgs) => Promise<ExternalTaskDetail>
  options: (provider: ExternalTaskProvider) => Promise<ExternalTaskEditOptions>
  update: (args: ExternalTaskUpdateArgs) => Promise<ExternalTaskDetail>
}
