import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  SkillInstallFailureSchema,
  classifySkillInstallFailureCode,
  type SkillInstallFailure
} from '../../shared/skill-install-failure'

export class SkillInstallOperationError extends Error {
  readonly code = SKILL_INSTALL_RPC_ERROR_CODE
  readonly data: SkillInstallFailure

  constructor(failure: SkillInstallFailure, options?: ErrorOptions) {
    super(failure.code, options)
    this.name = 'SkillInstallOperationError'
    this.data = SkillInstallFailureSchema.parse(failure)
  }
}

export function skillInstallFailureFromError(error: unknown): SkillInstallFailure | null {
  if (error instanceof SkillInstallOperationError) {
    return error.data
  }
  if (error && typeof error === 'object' && 'data' in error) {
    const parsed = SkillInstallFailureSchema.safeParse((error as { data: unknown }).data)
    if (parsed.success) {
      return parsed.data
    }
  }
  if (error instanceof Error) {
    const classified = classifySkillInstallFailureCode(error.message)
    if (classified) {
      return classified
    }
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      return {
        category: 'filesystem',
        code: 'skill-install-filesystem-failed',
        retryable: code === 'EBUSY' || code === 'EACCES' || code === 'EPERM'
      }
    }
  }
  return null
}
