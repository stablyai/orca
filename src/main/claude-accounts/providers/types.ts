import type {
  ClaudeAuthCredentials,
  ClaudeAuthMethod,
  ClaudeManagedAccount
} from '../../../shared/types'

export type RegisterAccountInput = {
  accountId: string
  managedAuthPath: string
  label?: string
  secretFromUser?: string
  providerConfig?: Partial<Extract<ClaudeAuthCredentials, { authMethod: ClaudeAuthMethod }>>
}

export type RegisterAccountResult = {
  accountId: string
  email: string
  credentials: ClaudeAuthCredentials
  organizationUuid: string | null
  organizationName: string | null
}

export type MaterializedEnvPatch = {
  envPatch: Record<string, string>
  configDirPath?: string
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; rescueHint?: string }

export type ProviderHandler = {
  authMethod: ClaudeAuthMethod
  registerAccount: (input: RegisterAccountInput) => Promise<RegisterAccountResult>
  materialize: (account: ClaudeManagedAccount) => Promise<MaterializedEnvPatch>
  validate: (account: ClaudeManagedAccount) => Promise<ValidationResult>
}
