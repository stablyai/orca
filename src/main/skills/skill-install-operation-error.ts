import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  SkillInstallFailureSchema,
  classifySkillInstallFailureCode,
  type SkillInstallFailure
} from '../../shared/skill-install-failure'
import { SkillCloudRequestError } from './skill-cloud-request'

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
  // Why: its `code` is the server's error code, not a Node errno, so the errno branch below
  // would report every cloud failure as a filesystem one.
  if (error instanceof SkillCloudRequestError) {
    return {
      category: 'transport',
      code: 'skill-cloud-request-failed',
      retryable: error.statusCode >= 500 || error.statusCode === 429
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

/**
 * Why: a download grant is the first cloud request of an install, and it throws.
 * Neither `withoutAuth` nor `runSkillCloudOperation` turns a failed request into an
 * operation result, and the grant is created before the install path's own
 * try/catch, so a 503 while authorizing reached the renderer unclassified while the
 * same 503 one step later was transport and retryable.
 */
export async function authorizeSkillDownload<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create()
  } catch (error) {
    const failure = skillInstallFailureFromError(error)
    if (!failure) {
      throw error
    }
    throw new SkillInstallOperationError(failure, { cause: error })
  }
}
