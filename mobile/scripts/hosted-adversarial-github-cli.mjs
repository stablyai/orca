#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const configPath = process.env.ORCA_E2E_GITHUB_FIXTURE_PATH

export async function hostedAdversarialGitHubResponse(args, config) {
  const endpoint = args.find(
    (value) =>
      value === 'graphql' ||
      value === 'rate_limit' ||
      value === 'user' ||
      value.startsWith('repos/') ||
      value.startsWith('search/')
  )
  if (args[0] === '--version') {
    return success('gh version 2.78.0 (Orca adversarial fixture)\n')
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    return success('Logged in to github.com as orca-e2e\n')
  }
  if (args[0] === 'repo' && args[1] === 'view') {
    return successJson({ isFork: false, parent: null })
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    return successJson([pullRequest(config)])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    return successJson(pullRequest(config))
  }
  if (args[0] !== 'api') {
    return failure(`Unsupported fixture gh command: ${args.join(' ')}`)
  }
  if (endpoint === 'user') {
    return successJson({ login: 'orca-e2e' })
  }
  if (endpoint === 'rate_limit') {
    return successJson({
      resources: {
        core: { limit: 5_000, remaining: 4_999, reset: 4_102_444_800 },
        graphql: { limit: 5_000, remaining: 4_999, reset: 4_102_444_800 },
        search: { limit: 30, remaining: 29, reset: 4_102_444_800 }
      }
    })
  }
  if (endpoint?.startsWith('search/issues')) {
    return endpoint.includes('repo%3Aorca-e2e%2Fadversarial')
      ? successJson([issue(config)])
      : failure(config.error)
  }
  if (endpoint === 'graphql') {
    return successJson(graphqlResponse(args, config))
  }
  if (endpoint?.includes('/pulls?head=')) {
    return successJson([restPullRequest(config)])
  }
  if (endpoint?.endsWith('/pulls/17/files?per_page=100')) {
    return successJson([
      {
        filename: 'README.md',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1 +1,2 @@\\n Adversarial mobile fixture\\n+provider fixture'
      }
    ])
  }
  if (endpoint?.endsWith('/issues/17/comments?per_page=100')) {
    return successJson([restComment(config)])
  }
  if (endpoint?.endsWith('/pulls/17/reviews?per_page=100')) {
    return successJson([])
  }
  if (endpoint?.endsWith('/pulls/17')) {
    return successJson({ ...restPullRequest(config), body: config.body })
  }
  return successJson([])
}

function graphqlResponse(args, config) {
  const query = args.find((value) => value.startsWith('query='))?.slice(6) ?? ''
  if (query.includes('reviewThreads(first: 100)')) {
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [] },
            comments: {
              nodes: [
                {
                  databaseId: 1701,
                  author: {
                    __typename: 'User',
                    login: 'orca-e2e',
                    avatarUrl: ''
                  },
                  body: config.comment,
                  createdAt: config.updatedAt,
                  url: 'https://github.com/orca-e2e/adversarial/pull/17#issuecomment-1701',
                  reactionGroups: []
                }
              ]
            }
          }
        }
      }
    }
  }
  if (query.includes('viewerViewedState')) {
    return {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_fixture_17',
            files: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ path: 'README.md', viewerViewedState: 'UNVIEWED' }]
            }
          }
        }
      }
    }
  }
  if (query.includes('participants(first:')) {
    return {
      data: {
        repository: {
          pullRequest: {
            participants: {
              nodes: [{ login: 'orca-e2e', name: 'Orca E2E', avatarUrl: '' }]
            }
          }
        }
      }
    }
  }
  if (query.includes('viewerDefaultMergeMethod')) {
    return {
      data: {
        repository: {
          viewerDefaultMergeMethod: 'SQUASH',
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
          autoMergeAllowed: false,
          mergeQueue: null
        }
      }
    }
  }
  if (query.includes('statusCheckRollup')) {
    return {
      data: {
        repository: {
          pullRequest: {
            headRefOid: config.headOid,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: { contexts: { nodes: [] } },
                    checkSuites: { nodes: [] }
                  }
                }
              ]
            }
          }
        }
      }
    }
  }
  if (/u\d+:\s*user/.test(query)) {
    return {
      data: {
        u0: { login: 'orca-e2e', name: 'Orca E2E', avatarUrl: '' }
      }
    }
  }
  return { data: { repository: {} } }
}

function pullRequest(config) {
  return {
    number: 17,
    title: config.title,
    state: 'OPEN',
    url: 'https://github.com/orca-e2e/adversarial/pull/17',
    labels: [],
    updatedAt: config.updatedAt,
    author: { login: 'orca-e2e', avatarUrl: '' },
    isDraft: false,
    headRefName: config.branch,
    baseRefName: 'main',
    headRefOid: config.headOid,
    baseRefOid: config.baseOid,
    headRepositoryOwner: { login: 'orca-e2e' },
    statusCheckRollup: [],
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    reviewRequests: [],
    latestReviews: [],
    assignees: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    maintainerCanModify: true
  }
}

function issue(config) {
  return {
    number: 17,
    title: config.title,
    state: 'open',
    html_url: 'https://github.com/orca-e2e/adversarial/issues/17',
    labels: [],
    updated_at: config.updatedAt,
    user: { login: 'orca-e2e', avatar_url: '' },
    assignees: []
  }
}

function restPullRequest(config) {
  return {
    number: 17,
    title: config.title,
    state: 'open',
    html_url: 'https://github.com/orca-e2e/adversarial/pull/17',
    updated_at: config.updatedAt,
    draft: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'clean',
    base: { ref: 'main', sha: config.baseOid },
    head: { ref: config.branch, sha: config.headOid }
  }
}

function restComment(config) {
  return {
    id: 1701,
    user: { login: 'orca-e2e', avatar_url: '', type: 'User' },
    body: config.comment,
    created_at: config.updatedAt,
    html_url: 'https://github.com/orca-e2e/adversarial/pull/17#issuecomment-1701'
  }
}

function success(stdout) {
  return { code: 0, stdout, stderr: '' }
}

function successJson(value) {
  return success(`${JSON.stringify(value)}\n`)
}

function failure(stderr) {
  return { code: 1, stdout: '', stderr: `${stderr}\n` }
}

async function main() {
  if (!configPath) {
    process.stderr.write('GitHub fixture path is unavailable\n')
    process.exitCode = 1
    return
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (typeof config.logPath === 'string') {
    await appendFile(config.logPath, `${JSON.stringify(process.argv.slice(2))}\n`)
  }
  const response = await hostedAdversarialGitHubResponse(process.argv.slice(2), config)
  process.stdout.write(response.stdout)
  process.stderr.write(response.stderr)
  process.exitCode = response.code
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
