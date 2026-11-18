// Why: kept apart from the request so the headless runtime can classify it without Electron.

/** The code of a refusal whose body named none, as a route the server doesn't have answers. */
export const SKILL_CLOUD_UNCODED_ERROR = 'skill_cloud_request_failed'

export class SkillCloudRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
