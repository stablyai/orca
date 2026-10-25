// Why: kept apart from the request so the headless runtime can classify it without Electron.
export class SkillCloudRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
