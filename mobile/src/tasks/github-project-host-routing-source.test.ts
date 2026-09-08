import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
// Composition layer: the hooks that drive Project rows.
const composition = [
  './use-mobile-tasks-project-loading-actions.tsx',
  './use-mobile-tasks-project-workspace-comment-actions.tsx',
  './use-mobile-tasks-project-thread-reply-actions.tsx',
  './use-mobile-tasks-project-detail-loading.tsx',
  './use-mobile-tasks-project-metadata-actions.tsx',
  './use-mobile-tasks-project-metadata-loading.tsx',
  './use-mobile-tasks-project-review-check-actions.tsx',
  './use-mobile-tasks-project-file-merge-actions.tsx'
].map(readSource)
const compositionSource = composition.join('\n')
// Adapter layer: where the composition's typed targets become RPC payloads.
const projectReadAdapter = readSource('./native-host-task-project-read-operations.ts')
const projectMutationAdapter = readSource('./native-host-task-project-mutation-operations.ts')
const projectFileAdapter = readSource('./native-host-task-project-file-operations.ts')
const adapterSource = [projectReadAdapter, projectMutationAdapter, projectFileAdapter].join('\n')
const slugPayloadContract = readSource(
  '../../../src/shared/mobile-web/task-project-metadata-contract.ts'
)
const projectRefContract = readSource(
  '../../../src/shared/mobile-web/task-project-read-contract.ts'
)

describe('mobile GitHub Project host routing boundary', () => {
  it('keeps every Project RPC behind the adapter layer', () => {
    expect(compositionSource).not.toContain('sendRequest(')
    expect(
      [...adapterSource.matchAll(/['"](github\.project\.[^'"]+)['"]/g)].length
    ).toBeGreaterThan(10)
  })

  it('host-qualifies every Project RPC request', () => {
    const calls = [...adapterSource.matchAll(/['"](github\.project\.[^'"]+)['"]/g)]
    for (const call of calls) {
      const request = adapterSource.slice(call.index, call.index + 700)
      expect(request, `${call[1]} must carry a host`).toMatch(
        /\bhost:|slugPayload\(target\)|\bpayload\b/
      )
    }
    // slugPayload is the single place a row identity becomes a wire payload.
    expect(projectMutationAdapter).toMatch(
      /function slugPayload\(target: HostTaskProjectItemTarget\) \{\s*return \{\s*owner: target\.owner,\s*repo: target\.repo,\s*host: target\.host,/
    )
    // Payloads forwarded whole are host-qualified by their shared contract.
    expect(slugPayloadContract).toMatch(/host: z\.string\(\)\.min\(1\)/)
    expect(projectRefContract).toContain('MobileWebTaskProjectListPayloadSchema')
    expect(projectRefContract).toMatch(/host: HostSchema\b/)
  })

  it('pins Project-row PR actions to the row repository identity', () => {
    // Every Project-row action resolves its target from the row plus the active Project host.
    const targets = [...compositionSource.matchAll(/projectRowMutationTarget\(([^)]*)\)/g)]
    expect(targets.length).toBeGreaterThan(10)
    for (const target of targets) {
      expect(target[1].replace(/\s+/g, ' ').trim()).toBe('row, activeGitHubProjectHost')
    }
    // The target type carries the host that the PR mutations forward as prRepo.
    expect(projectMutationAdapter).toContain('prRepo: slugPayload(target)')
    for (const method of [
      'fetchResolveReviewThread',
      'fetchAddPRReviewCommentReply',
      'fetchAddIssueComment',
      'fetchRequestPRReviewers',
      'fetchRerunPRChecks',
      'fetchMergePR'
    ]) {
      expect(projectMutationAdapter, `${method} must remain wired`).toContain(method)
    }
    for (const method of ['github.prChecks', 'github.setPRFileViewed', 'github.prFileContents']) {
      expect(projectFileAdapter, `${method} must remain wired`).toContain(method)
    }
  })

  it('pins discovery to github.com while pasted URLs supply their parsed host', () => {
    expect(compositionSource).toContain("listAccessible('github.com')")
    expect(compositionSource).toContain('host: githubProjectHost(parsed.host)')
  })
})
