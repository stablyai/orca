import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearIssueContextResult,
  LinearSearchResult,
  LinearStatusSetResult
} from '../../shared/linear-agent-access'
import type { CliStatusResult } from '../../shared/runtime-types'
import type { RpcResponse } from '../runtime/rpc/core'

export function formatRemoteCli(response: RpcResponse): { stdout: string; stderr: string } {
  if (!response.ok) {
    return { stdout: '', stderr: `${formatRemoteCliError(response.error)}\n` }
  }
  const result = response.result
  if (isRecord(result) && 'app' in result && 'runtime' in result && 'graph' in result) {
    const record = result as Record<string, unknown>
    return formatStatusResult(record as CliStatusResult)
  }
  if (isLinearIssueContextResult(result)) {
    return {
      stdout: `${formatLinearIssue(result)}\n`,
      stderr: linearIssueWarnings(result)
    }
  }
  if (isLinearSearchResult(result)) {
    return {
      stdout: `${formatLinearSearch(result)}\n`,
      stderr: linearSearchWarnings(result)
    }
  }
  if (isLinearStatusSetResult(result)) {
    return { stdout: `${formatLinearStatusSet(result)}\n`, stderr: '' }
  }
  if (isLinearCommentAddResult(result)) {
    return { stdout: `${formatLinearCommentAdd(result)}\n`, stderr: '' }
  }
  if (isLinearAttachResult(result)) {
    return { stdout: `${formatLinearAttach(result)}\n`, stderr: '' }
  }
  if (isLinearCreateResult(result)) {
    return { stdout: `${formatLinearCreate(result)}\n`, stderr: '' }
  }
  return { stdout: `${JSON.stringify(result)}\n`, stderr: '' }
}

function formatRemoteCliError(error: { message: string; data?: unknown }): string {
  const nextSteps =
    isRecord(error.data) && Array.isArray(error.data.nextSteps)
      ? error.data.nextSteps.filter((step): step is string => typeof step === 'string')
      : []
  if (nextSteps.length === 0) {
    return error.message
  }
  return `${error.message}\n${nextSteps.map((step) => `Next step: ${step}`).join('\n')}`
}

function formatStatusResult(status: CliStatusResult): { stdout: string; stderr: string } {
  return {
    stdout: `${[
      `appRunning: ${status.app.running}`,
      `pid: ${status.app.pid ?? 'none'}`,
      `runtimeState: ${status.runtime.state}`,
      `runtimeReachable: ${status.runtime.reachable}`,
      `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
      `graphState: ${status.graph.state}`
    ].join('\n')}\n`,
    stderr: ''
  }
}

function isLinearIssueContextResult(result: unknown): result is LinearIssueContextResult {
  if (!isRecord(result)) {
    return false
  }
  const issue = result.issue
  const meta = result.meta
  if (!isRecord(issue) || !isRecord(meta)) {
    return false
  }
  return (
    typeof issue.identifier === 'string' &&
    typeof issue.title === 'string' &&
    typeof issue.url === 'string' &&
    Array.isArray(issue.labels) &&
    Array.isArray(meta.includeErrors) &&
    isRecord(meta.sections)
  )
}

function isLinearSearchResult(result: unknown): result is LinearSearchResult {
  if (!isRecord(result) || !isRecord(result.meta)) {
    return false
  }
  return (
    Array.isArray(result.issues) &&
    typeof result.meta.query === 'string' &&
    typeof result.meta.returned === 'number'
  )
}

function isLinearStatusSetResult(result: unknown): result is LinearStatusSetResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.state) &&
    isRecord(result.meta) &&
    typeof result.state.name === 'string' &&
    typeof result.meta.alreadyInState === 'boolean'
  )
}

function isLinearCommentAddResult(result: unknown): result is LinearCommentAddResult {
  return (
    isRecord(result) &&
    isRecord(result.comment) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.comment.id === 'string' &&
    typeof result.meta.bodyChars === 'number'
  )
}

function isLinearAttachResult(result: unknown): result is LinearAttachResult {
  return (
    isRecord(result) &&
    isRecord(result.attachment) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.attachment.title === 'string' &&
    typeof result.attachment.url === 'string'
  )
}

function isLinearCreateResult(result: unknown): result is LinearCreateResult {
  return (
    isRecord(result) &&
    isRecord(result.issue) &&
    isRecord(result.meta) &&
    typeof result.issue.identifier === 'string' &&
    typeof result.issue.title === 'string' &&
    typeof result.meta.writeId === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function formatLinearIssue(result: LinearIssueContextResult): string {
  const issue = result.issue
  const lines: string[] = []
  lines.push(`${issue.identifier} ${issue.title}`)
  lines.push(`URL: ${issue.url}`)
  lines.push(`State: ${issue.state?.name ?? 'unknown'}`)
  lines.push(`Assignee: ${issue.assignee?.displayName ?? 'unassigned'}`)
  lines.push(`Project: ${issue.project?.name ?? 'none'}`)
  if (issue.labels.length > 0) {
    lines.push(
      `Labels: ${issue.labels
        .map((label) => label.name)
        .filter(Boolean)
        .join(', ')}`
    )
  }
  for (const section of ['comments', 'children', 'attachments', 'relations'] as const) {
    const meta = result.meta.sections[section]
    if (meta) {
      lines.push(`${section[0].toUpperCase()}${section.slice(1)}: ${meta.returned}`)
    }
  }
  return lines.join('\n')
}

function formatLinearSearch(result: LinearSearchResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return result.issues
    .map((issue) => {
      const state = issue.state?.name ?? 'unknown'
      const assignee = issue.assignee?.displayName ?? 'unassigned'
      return `${issue.identifier.padEnd(10)} ${state.padEnd(14)} ${assignee.padEnd(18)} ${issue.title}`
    })
    .join('\n')
}

function formatLinearStatusSet(result: LinearStatusSetResult): string {
  const suffix = result.meta.alreadyInState ? ' (already set)' : ''
  return `Set ${result.issue.identifier} to ${result.state.name}${suffix}.`
}

function formatLinearCommentAdd(result: LinearCommentAddResult): string {
  const suffix = result.meta.deduplicated ? ' (already posted)' : ''
  return `Added comment ${result.comment.id} to ${result.issue.identifier}${suffix}.`
}

function formatLinearAttach(result: LinearAttachResult): string {
  const suffix = result.meta.deduplicated ? ' (already attached)' : ''
  return `Attached ${result.attachment.title} to ${result.issue.identifier}${suffix}.`
}

function formatLinearCreate(result: LinearCreateResult): string {
  const parent = result.issue.parent ? ` under ${result.issue.parent.identifier}` : ''
  const suffix = result.meta.deduplicated ? ' (already created)' : ''
  return `Created ${result.issue.identifier}${parent}: ${result.issue.title}${suffix}.`
}

function linearIssueWarnings(result: LinearIssueContextResult): string {
  const warnings: string[] = []
  for (const error of result.meta.includeErrors) {
    warnings.push(`warning: ${error.include} unavailable: ${error.message}`)
  }
  for (const [name, meta] of Object.entries(result.meta.sections)) {
    if (meta?.capReached) {
      warnings.push(`warning: ${name} capped at ${meta.returned}/${meta.cap}`)
    }
  }
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}

function linearSearchWarnings(result: LinearSearchResult): string {
  const warnings: string[] = []
  if (result.meta.limitReached) {
    warnings.push(`warning: showing first ${result.meta.returned} Linear issues`)
  }
  for (const error of result.meta.workspaceErrors ?? []) {
    warnings.push(
      `warning: ${error.workspace.name} unavailable for Linear search: ${error.message}`
    )
  }
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}
