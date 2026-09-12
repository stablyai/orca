import type { NestedRepoScanResult, ProjectGroupImportResult } from '../shared/project-group-types'

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no'
}

export function formatNestedRepoScan(result: NestedRepoScanResult): string {
  const lines = [
    `root: ${result.selectedPath}`,
    `kind: ${result.selectedPathKind}`,
    `repositories: ${result.repos.length}`,
    `scan: ${result.durationMs}ms  truncated:${yesNo(result.truncated)}  timedOut:${yesNo(result.timedOut)}  stopped:${yesNo(result.stopped)}`
  ]
  if (result.repos.length === 0) {
    lines.push('No nested repositories found.')
    return lines.join('\n')
  }
  lines.push(
    ...result.repos.map((repo) => `${repo.displayName}  depth:${repo.depth}  ${repo.path}`)
  )
  return lines.join('\n')
}

export function formatNestedRepoImport(result: ProjectGroupImportResult): string {
  const lines = [
    `group: ${result.group ? `${result.group.name} (${result.group.id})` : 'none'}`,
    `imported: ${result.importedCount}`,
    `alreadyKnown: ${result.alreadyKnownCount}`,
    `failed: ${result.failedCount}`
  ]
  lines.push(
    ...result.projects.map((project) => {
      const projectId = project.projectId ? `  ${project.projectId}` : ''
      const error = project.error ? `  ${project.error}` : ''
      return `${project.status}${projectId}  ${project.path}${error}`
    })
  )
  return lines.join('\n')
}
