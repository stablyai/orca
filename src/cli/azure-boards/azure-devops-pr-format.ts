import type {
  AzureDevOpsPrBuild,
  AzureDevOpsPrCheck,
  AzureDevOpsPrDetail,
  AzureDevOpsPrFiles,
  AzureDevOpsPrSummary,
  AzureDevOpsPrThread
} from '../../shared/azure-devops/azure-devops-pr-review-types'

export function formatAzureDevOpsPrList(prs: AzureDevOpsPrSummary[]): string {
  if (prs.length === 0) {
    return 'No pull requests.'
  }
  return prs
    .map((pr) =>
      [
        pr.id,
        `${pr.project}/${pr.repository}`,
        pr.myVote ?? '-',
        pr.author ?? '',
        `${pr.sourceBranch} -> ${pr.targetBranch}`,
        pr.title
      ].join('\t')
    )
    .join('\n')
}

export function formatAzureDevOpsPr(pr: AzureDevOpsPrDetail | null): string {
  if (!pr) {
    return 'Pull request not found.'
  }
  return [
    `PR ${pr.id}: ${pr.title}${pr.isDraft ? ' (draft)' : ''}`,
    `Status: ${pr.status}${pr.mergeStatus ? `, merge ${pr.mergeStatus}` : ''}`,
    `Repository: ${pr.project}/${pr.repository}  ${pr.sourceBranch} -> ${pr.targetBranch}`,
    `Author: ${pr.author ?? 'unknown'}`,
    `Iterations: ${pr.iterationCount}  head ${pr.sourceCommit?.slice(0, 10) ?? '?'}`,
    'Reviewers:',
    ...pr.reviewers.map(
      (reviewer) =>
        `  ${reviewer.voteLabel}\t${reviewer.displayName}${reviewer.isRequired ? ' (required)' : ''}${reviewer.isMe ? ' (you)' : ''}`
    ),
    `URL: ${pr.url}`,
    ...(pr.description.trim() ? ['', pr.description.trim()] : [])
  ].join('\n')
}

export function formatAzureDevOpsPrThreads(threads: AzureDevOpsPrThread[]): string {
  if (threads.length === 0) {
    return 'No discussion threads.'
  }
  return threads
    .map((thread) =>
      [
        `#${thread.id} ${thread.status ?? 'comment'}${thread.filePath ? ` ${thread.filePath}${thread.line ? `:${thread.line}` : ''}` : ''}`,
        ...thread.comments.map(
          (comment) =>
            `  ${comment.author ?? 'unknown'} (${comment.publishedDate ?? ''}): ${comment.content.replace(/\s*\n\s*/g, ' ')}`
        )
      ].join('\n')
    )
    .join('\n\n')
}

export function formatAzureDevOpsPrChecks(checks: AzureDevOpsPrCheck[]): string {
  if (checks.length === 0) {
    return 'No policies or statuses.'
  }
  return checks
    .map((check) =>
      [
        check.status,
        check.kind,
        `${check.name}${check.isBlocking ? ' (required)' : ''}${check.isStale ? ' (stale build)' : ''}${check.buildId !== null ? ` [build ${check.buildId}]` : ''}`,
        check.url ?? ''
      ]
        .join('\t')
        .trimEnd()
    )
    .join('\n')
}

export function formatAzureDevOpsPrFiles(files: AzureDevOpsPrFiles): string {
  const header = `Iteration ${files.iteration}${files.comparedTo > 0 ? ` since iteration ${files.comparedTo}` : ' since merge base'}  base ${files.baseCommit ?? '?'}  head ${files.headCommit ?? '?'}`
  return [
    header,
    ...(files.files.length === 0
      ? ['No changed files.']
      : files.files.map(
          (file) =>
            `${file.changeType}\t${file.path}${file.originalPath && file.originalPath !== file.path ? ` (from ${file.originalPath})` : ''}`
        ))
  ].join('\n')
}

export function formatAzureDevOpsPrBuild(build: AzureDevOpsPrBuild): string {
  return [
    `Build ${build.number ?? build.id} ${build.definition ?? ''}: ${build.status ?? '?'}${build.result ? `, ${build.result}` : ''}`.trim(),
    ...(build.url ? [`URL: ${build.url}`] : []),
    ...build.steps
      .filter((step) => step.type === 'Task' || step.type === 'Job')
      .map(
        (step) =>
          `  ${step.result ?? step.state ?? '?'}\t${step.type}\t${step.name}${step.issues.length > 0 ? `\n${step.issues.map((issue) => `      ${issue}`).join('\n')}` : ''}`
      ),
    ...build.logs.flatMap((log) => [
      '',
      `--- ${log.step}${log.truncated ? ' (last lines)' : ''}`,
      ...log.lines
    ])
  ].join('\n')
}
