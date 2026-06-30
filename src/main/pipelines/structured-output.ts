import type { PipelinePlannerOutputV1 } from '../../shared/pipeline-template-types'

export type PipelineStructuredOutputFailureKind =
  | 'missing_tag'
  | 'invalid_json'
  | 'schema_validation'

export type PipelineStructuredOutputContext = {
  runId: string
  iterationId?: string | null
  stageId?: string | null
  terminalId?: string | null
}

export class PipelineStructuredOutputError extends Error {
  readonly failureKind: PipelineStructuredOutputFailureKind
  readonly runId: string
  readonly iterationId: string | null
  readonly stageId: string | null
  readonly terminalId: string | null
  readonly tag: string
  readonly rawOutputSummary: string

  constructor(args: {
    message: string
    failureKind: PipelineStructuredOutputFailureKind
    context: PipelineStructuredOutputContext
    tag: string
    rawOutput: string
  }) {
    super(args.message)
    this.name = 'PipelineStructuredOutputError'
    this.failureKind = args.failureKind
    this.runId = args.context.runId
    this.iterationId = args.context.iterationId ?? null
    this.stageId = args.context.stageId ?? null
    this.terminalId = args.context.terminalId ?? null
    this.tag = args.tag
    this.rawOutputSummary = summarizeRawOutput(args.rawOutput)
  }
}

export function extractPipelinePlannerOutput(
  stdout: string,
  context: PipelineStructuredOutputContext
): PipelinePlannerOutputV1 {
  const tag = 'plan'
  const raw = findLastTagContent(stdout, tag)
  if (raw === undefined) {
    throw new PipelineStructuredOutputError({
      message: `Structured output tag <${tag}> not found in planner output`,
      failureKind: 'missing_tag',
      context,
      tag,
      rawOutput: stdout
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapJsonFence(raw.trim()))
  } catch {
    throw new PipelineStructuredOutputError({
      message: `Structured output tag <${tag}> contains invalid JSON`,
      failureKind: 'invalid_json',
      context,
      tag,
      rawOutput: raw
    })
  }

  if (!isPipelinePlannerOutputV1(parsed)) {
    throw new PipelineStructuredOutputError({
      message: `Structured output tag <${tag}> failed schema validation`,
      failureKind: 'schema_validation',
      context,
      tag,
      rawOutput: raw
    })
  }

  return parsed
}

function findLastTagContent(text: string, tag: string): string | undefined {
  const openTag = `<${tag}>`
  const closeTag = `</${tag}>`
  let lastContent: string | undefined
  let searchFrom = 0

  while (true) {
    const openIndex = text.indexOf(openTag, searchFrom)
    if (openIndex === -1) {
      break
    }
    const contentStart = openIndex + openTag.length
    const closeIndex = text.indexOf(closeTag, contentStart)
    if (closeIndex === -1) {
      break
    }
    lastContent = text.slice(contentStart, closeIndex)
    searchFrom = closeIndex + closeTag.length
  }

  return lastContent
}

function unwrapJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n\s*```\s*$/i)
  return match ? match[1]!.trim() : text
}

function isPipelinePlannerOutputV1(value: unknown): value is PipelinePlannerOutputV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const issues = (value as { issues?: unknown }).issues
  if (!Array.isArray(issues)) {
    return false
  }
  return issues.every((issue) => {
    if (!issue || typeof issue !== 'object') {
      return false
    }
    const candidate = issue as {
      id?: unknown
      title?: unknown
      branch?: unknown
      blockedBy?: unknown
    }
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.branch === 'string' &&
      (candidate.blockedBy === undefined ||
        (Array.isArray(candidate.blockedBy) &&
          candidate.blockedBy.every((blocker) => typeof blocker === 'string')))
    )
  })
}

function summarizeRawOutput(raw: string, limit = 500): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`
}
