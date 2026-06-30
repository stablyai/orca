export class PipelineReviewMergeVerifyError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PipelineReviewMergeVerifyError'
    this.code = code
    this.details = details
  }
}

export function toPipelineReviewMergeVerifyError(error: unknown): {
  message: string
  code?: string
  details?: unknown
} {
  if (error instanceof PipelineReviewMergeVerifyError) {
    return { message: error.message, code: error.code, details: error.details }
  }
  if (error instanceof Error) {
    return { message: error.message }
  }
  return { message: String(error) }
}
