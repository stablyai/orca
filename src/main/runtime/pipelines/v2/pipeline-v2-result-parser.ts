import { PipelineV2Submission } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parsePipelineV2Result(text: string) {
  const json = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(text.trim())?.[1] ?? text
  let input: unknown
  try {
    input = JSON.parse(json)
  } catch {
    return {
      success: false as const,
      errors: [{ path: '', code: 'invalid_json', message: 'Final response is not valid JSON' }]
    }
  }
  if (
    record(input) &&
    record(input.evidence) &&
    (input.explanation === undefined || typeof input.explanation === 'string')
  ) {
    const evidence = { ...input.evidence }
    const annotations: Record<string, unknown> = {}
    for (const key of ['verification', 'commit', 'notes', 'explanation']) {
      if (Object.hasOwn(evidence, key)) {
        annotations[key] = evidence[key]
        delete evidence[key]
      }
    }
    if (Object.keys(annotations).length) {
      input = {
        ...input,
        evidence,
        explanation: [input.explanation, JSON.stringify({ evidenceAnnotations: annotations })]
          .filter((value) => value !== undefined)
          .join('\n')
      }
    }
  }
  const parsed = PipelineV2Submission.safeParse(input)
  return parsed.success
    ? parsed
    : {
        success: false as const,
        errors: parsed.error.issues.slice(0, 32).map((issue) => ({
          path: issue.path.map(String).join('.').slice(0, 500),
          code: issue.code,
          message: issue.message.slice(0, 1000)
        }))
      }
}
