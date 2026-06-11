import type { LinearIssueContextResult, LinearSearchResult } from '../../shared/linear-agent-access'
import type { CliStatusResult } from '../../shared/runtime-types'
import type { RpcResponse } from '../runtime/rpc/core'

export function formatRemoteCli(response: RpcResponse): { stdout: string; stderr: string } {
  if (!response.ok) {
    return { stdout: '', stderr: `${response.error.message}\n` }
  }
  const result = response.result
  const record = result as Record<string, unknown>
  if ('app' in record && 'runtime' in record && 'graph' in record) {
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
  return { stdout: `${JSON.stringify(result)}\n`, stderr: '' }
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
  return (
    Boolean(result) &&
    result !== null &&
    typeof result === 'object' &&
    'issue' in result &&
    'meta' in result &&
    typeof (result as { meta?: { includeErrors?: unknown } }).meta?.includeErrors === 'object'
  )
}

function isLinearSearchResult(result: unknown): result is LinearSearchResult {
  return (
    Boolean(result) &&
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { issues?: unknown }).issues) &&
    'meta' in result &&
    typeof (result as { meta?: { query?: unknown } }).meta?.query === 'string'
  )
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
