import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
// Composition layer: the hooks that drive Project rows.
const compositionSource = [
  './use-mobile-tasks-project-loading-actions.tsx',
  './use-mobile-tasks-project-workspace-comment-actions.tsx',
  './use-mobile-tasks-project-thread-reply-actions.tsx',
  './use-mobile-tasks-project-detail-loading.tsx',
  './use-mobile-tasks-project-metadata-actions.tsx',
  './use-mobile-tasks-project-metadata-loading.tsx',
  './use-mobile-tasks-project-review-check-actions.tsx',
  './use-mobile-tasks-project-file-merge-actions.tsx'
]
  .map(readSource)
  .join('\n')
// Adapter layer: where the composition's typed targets become RPC payloads.
const projectReadAdapter = readSource('./native-host-task-project-read-operations.ts')
const projectMutationAdapter = readSource('./native-host-task-project-mutation-operations.ts')
const projectFileAdapter = readSource('./native-host-task-project-file-operations.ts')
const projectPayloadTypes = readSource('./host-task-project-payloads.ts')
/** The fallback map lists every method name as a key; those are not call sites. */
const mutationCallSites = projectMutationAdapter.replace(
  /const PROJECT_MUTATION_FALLBACKS[\s\S]*?\n\}\n/,
  ''
)
const adapterSource = [projectReadAdapter, mutationCallSites, projectFileAdapter].join('\n')

/** These four pass a typed payload rather than an inline object, so their host is guaranteed by
 *  the payload type asserted below. Pinned by name so a new call cannot silently join them. */
const TYPED_PAYLOAD_CALLS = new Set([
  'github.project.workItemDetailsBySlug',
  'github.project.listLabelsBySlug',
  'github.project.listAssignableUsersBySlug',
  'github.project.listIssueTypesBySlug'
])

/** The adapter method that contains `offset`, ending at its closing brace at 4-space indent
 *  (`},` or the last method's `}`); a method that never closes fails rather than leaking into
 *  the next method or file. */
function enclosingAdapterMethod(source: string, offset: number): string {
  const end = source.slice(offset).search(/\n {4}\},?\n/)
  if (end === -1) {
    throw new Error(`no method boundary after offset ${offset}`)
  }
  return source.slice(offset, offset + end)
}

describe('mobile GitHub Project host routing boundary', () => {
  it('keeps every Project RPC behind the adapter layer', () => {
    expect(compositionSource).not.toContain('sendRequest(')
    expect(
      [...adapterSource.matchAll(/['"](github\.project\.[^'"]+)['"]/g)].length
    ).toBeGreaterThan(10)
  })

  it('host-qualifies every Project RPC request', () => {
    const calls = [...adapterSource.matchAll(/['"](github\.project\.[^'"]+)['"]/g)]
    expect(calls.length).toBeGreaterThan(10)
    for (const call of calls) {
      if (TYPED_PAYLOAD_CALLS.has(call[1])) {
        continue
      }
      // Bounded to the enclosing adapter method, so a neighbour's host cannot satisfy it.
      const request = enclosingAdapterMethod(adapterSource, call.index)
      // `host` may be a shorthand property, so accept it followed by a colon, comma or brace.
      expect(request, `${call[1]} must carry a host`).toMatch(
        /\bhost\s*[:,}]|slugPayload\(target\)|repoPayload\(/
      )
    }
    // The typed-payload calls get their host from the type, so pin the type instead.
    expect(projectPayloadTypes).toMatch(
      /export type HostTaskProjectSlugPayload = \{\s*owner: string\s*repo: string\s*host: string/
    )
    for (const derived of [
      'HostTaskProjectItemDetailPayload',
      'HostTaskProjectAssignableUsersPayload'
    ]) {
      expect(projectPayloadTypes, `${derived} must inherit the host`).toMatch(
        new RegExp(`export type ${derived} = HostTaskProjectSlugPayload &`)
      )
    }
    expect(projectPayloadTypes).toMatch(
      /export type HostTaskProjectTablePayload = GitHubProjectRef &/
    )
    // slugPayload is the single place a row identity becomes a wire payload.
    expect(projectMutationAdapter).toMatch(
      /function slugPayload\(target: HostTaskProjectItemTarget\) \{\s*return \{\s*owner: target\.owner,\s*repo: target\.repo,\s*host: target\.host,/
    )
  })

  it('pins Project-row PR actions to the row repository identity', () => {
    // Every Project-row action resolves its target from the row plus the active Project host.
    const targets = [
      ...compositionSource.matchAll(
        /projectRow(?:Mutation|PullRequest|Slug|Identity)Target\(([^)]*)\)/g
      )
    ]
    expect(targets.length).toBeGreaterThan(10)
    for (const target of targets) {
      expect(target[1].replace(/\s+/g, ' ').trim()).toBe('row, activeGitHubProjectHost')
    }
    // The target type carries the host that the PR mutations forward as prRepo, and a row with
    // no slug forwards null rather than being refused.
    expect(projectMutationAdapter).toMatch(
      /function prRepoPayload\(target: HostTaskProjectItemTarget\) \{\s*return target\.owner && target\.repo/
    )
    // Per method, not once per file: dropping prRepo from a single mutation must fail here.
    for (const method of [
      'github.resolveReviewThread',
      'github.addPRReviewCommentReply',
      'github.addIssueComment',
      'github.requestPRReviewers',
      'github.rerunPRChecks',
      'github.mergePR'
    ]) {
      const offset = projectMutationAdapter.indexOf(`'${method}'`)
      expect(offset, `${method} must remain wired`).toBeGreaterThan(-1)
      // Bounded to this adapter method, so a neighbour's prRepo cannot satisfy it.
      expect(
        enclosingAdapterMethod(projectMutationAdapter, offset),
        `${method} must carry prRepo`
      ).toContain('prRepo: prRepoPayload(target)')
    }
    for (const method of [
      'github.prChecks',
      'github.setPRFileViewed',
      'github.prFileContents',
      'github.addPRReviewComment'
    ]) {
      const offset = projectFileAdapter.indexOf(`'${method}'`)
      expect(offset, `${method} must remain wired`).toBeGreaterThan(-1)
      expect(
        enclosingAdapterMethod(projectFileAdapter, offset),
        `${method} must carry the row repository`
      ).toContain('repoPayload(target, repoId)')
    }
  })

  it('pins discovery to github.com while pasted URLs supply their parsed host', () => {
    expect(compositionSource).toContain("listAccessible('github.com')")
    expect(compositionSource).toContain('host: githubProjectHost(parsed.host)')
  })
})
