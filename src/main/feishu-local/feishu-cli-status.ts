import { z } from 'zod'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

import { FEISHU_CLI_MISSING } from '../../shared/bots/feishu-local'
export type FeishuProblem =
  | 'cli-missing'
  | 'profile-changed'
  | 'permission'
  | 'subscription'
  | 'retrying'
export class FeishuHostError extends Error {
  constructor(readonly problem: FeishuProblem) {
    super(problem === 'cli-missing' ? FEISHU_CLI_MISSING : `Feishu connection: ${problem}`)
  }
}
export function feishuProblem(error: unknown): FeishuProblem {
  if (error instanceof FeishuHostError) {
    return error.problem
  }
  return errnoCodeOrUnknown(error) === 'ENOENT' ? 'cli-missing' : 'retrying'
}

/** Only expose the category; CLI diagnostics can contain application IDs and console URLs. */
export function feishuDiagnostic(stderr: string): FeishuProblem {
  try {
    const { error } = z
      .object({
        ok: z.literal(false),
        error: z.object({ subtype: z.string(), message: z.string().optional() })
      })
      .parse(JSON.parse(stderr))
    if (error.subtype === 'missing_scope' || error.subtype === 'access_denied') {
      return 'permission'
    }
    // The event preflight uses the generic failed_precondition subtype for unsubscribed events.
    if (
      error.subtype === 'failed_precondition' &&
      error.message?.includes('not subscribed in console')
    ) {
      return 'subscription'
    }
  } catch {
    /* Other CLI versions and transport failures keep the general reconnect status. */
  }
  return 'retrying'
}
