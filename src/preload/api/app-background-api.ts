import type {
  AppBackgroundCommitArgs,
  AppBackgroundCommitResult,
  AppBackgroundPickResult,
  AppBackgroundReadArgs
} from '../../shared/app-background-types'

export type AppBackgroundApi = {
  pick: () => Promise<AppBackgroundPickResult>
  read: (args: AppBackgroundReadArgs) => Promise<ArrayBuffer | null>
  commit: (args: AppBackgroundCommitArgs) => Promise<AppBackgroundCommitResult>
  discard: (stagingId: string) => Promise<void>
}
