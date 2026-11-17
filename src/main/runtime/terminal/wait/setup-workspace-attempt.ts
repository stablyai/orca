import type { SetupAttemptRecipe } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'

type SetupCompletion = { exitCode: number | null }
export type SetupWorkspaceAttempt = {
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
  bound: boolean
  result?: SetupCompletion
  recipe?: SetupAttemptRecipe
  available: Promise<void>
  publish: () => void
  cancel: () => void
  cancelled: boolean
  publication?: AbortController
  writerToken?: string
  reservations: Set<symbol>
  writers: Set<object>
}
