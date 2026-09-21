import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const productRoot = resolve(import.meta.dirname, '..')
const source = [
  readSource('./use-mobile-tasks-project-loading-actions.tsx'),
  readSource('./use-mobile-tasks-project-workspace-comment-actions.tsx'),
  readSource('./use-mobile-tasks-project-thread-reply-actions.tsx'),
  readSource('./use-mobile-tasks-project-detail-loading.tsx'),
  readSource('./use-mobile-tasks-project-metadata-actions.tsx'),
  readSource('./use-mobile-tasks-project-metadata-loading.tsx'),
  readSource('./use-mobile-tasks-project-review-check-actions.tsx'),
  readSource('./use-mobile-tasks-project-file-merge-actions.tsx')
].join('\n')
const boardOperations = readSource('./mobile-task-project-board-operations.ts')
const itemOperations = [
  readSource('./mobile-task-item-state-operations.ts'),
  readSource('./mobile-task-item-comment-operations.ts')
].join('\n')

/** The operation a board site sends now names the method, so the pin is in two halves: the
 *  site carries the host or the row identity, and the operation still sends that method. */
function sendsMethod(operations: string, operation: string, method: string): boolean {
  const offset = operations.indexOf(`export const ${operation} =`)
  return offset !== -1 && operations.slice(offset, offset + 400).includes(`method: '${method}'`)
}

/** Every product file that could send a board request. Recorder fixtures are not call sites. */
function productSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'test-support' ? [] : productSources(path)
    }
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

/**
 * The board's operations by the method each declares, never by the `githubProject` identifier
 * prefix: renaming an operation off that prefix takes it out of a prefix match, so the rename can
 * delete the host with this test still green. The method it sends is what routing follows.
 */
function projectOperations(): string[] {
  const declarations = [...boardOperations.matchAll(/export const (\w+) =/g)]
  return declarations
    .filter((declaration, index) =>
      boardOperations
        .slice(declaration.index, declarations[index + 1]?.index ?? boardOperations.length)
        .includes("method: 'github.project.")
    )
    .map((declaration) => declaration[1]!)
}

describe('mobile GitHub Project host routing boundary', () => {
  it('host-qualifies every Project RPC request', () => {
    const operations = projectOperations()
    expect(operations.length).toBeGreaterThan(10)
    const unrouted: string[] = []
    const wired = new Set<string>()
    for (const path of productSources(productRoot)) {
      const contents = readFileSync(path, 'utf8')
      for (const operation of operations) {
        for (const call of contents.matchAll(new RegExp(`\\b${operation}\\s*\\.request\\(`, 'g'))) {
          wired.add(operation)
          if (!/\bhost\s*:/.test(contents.slice(call.index, call.index + 700))) {
            unrouted.push(`${relative(productRoot, path)} sends ${operation} with no host`)
          }
        }
      }
    }
    expect(unrouted).toEqual([])
    expect(operations.filter((operation) => !wired.has(operation))).toEqual([])
  })

  it('pins Project-row PR actions to the row repository identity', () => {
    const actions = source.slice(source.indexOf('const toggleProjectGitHubReviewThread'))
    for (const [operation, method] of [
      ['githubReviewThreadResolve', 'github.resolveReviewThread'],
      ['githubReviewCommentReplyWrite', 'github.addPRReviewCommentReply'],
      ['githubIssueCommentWrite', 'github.addIssueComment'],
      ['githubReviewerRequest', 'github.requestPRReviewers'],
      ['githubPullRequestChecksRead', 'github.prChecks'],
      ['githubPullRequestChecksRerun', 'github.rerunPRChecks'],
      ['githubPullRequestFileViewedWrite', 'github.setPRFileViewed'],
      ['githubPullRequestFileContentsRead', 'github.prFileContents'],
      ['githubReviewCommentWrite', 'github.addPRReviewComment'],
      ['githubPullRequestMerge', 'github.mergePR']
    ] as const) {
      const offset = actions.indexOf(`${operation}.request(`)
      expect(offset, `${method} must remain wired in the Project action path`).toBeGreaterThan(-1)
      expect(actions.slice(offset, offset + 700), `${method} must carry prRepo`).toContain(
        'prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost)'
      )
      expect(
        sendsMethod(itemOperations, operation, method),
        `${operation} must still send ${method}`
      ).toBe(true)
    }
  })

  it('pins discovery to github.com while pasted URLs supply their parsed host', () => {
    expect(source).toContain("githubProjectListRead.request(client, { host: 'github.com' })")
    expect(
      sendsMethod(boardOperations, 'githubProjectListRead', 'github.project.listAccessible')
    ).toBe(true)
    expect(source).toContain('host: githubProjectHost(parsed.host)')
  })
})
