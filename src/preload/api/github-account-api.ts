import type {
  GhAccountBindingInventory,
  GhAccountBindingValidationResult
} from '../../shared/github/accounts/auth-types'

export type GithubAccountApi = {
  listBindableAccounts: (args: {
    repoPath: string
    repoId?: string
    refreshCapability?: boolean
  }) => Promise<GhAccountBindingInventory>
  validateAccountBinding: (args: {
    repoPath: string
    repoId?: string
    host: string
    user: string
  }) => Promise<GhAccountBindingValidationResult>
}
