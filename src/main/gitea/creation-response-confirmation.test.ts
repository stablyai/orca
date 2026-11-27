import { afterEach, expect, it, vi } from 'vitest'
import type { CreateHostedReviewInput } from '../../shared/source-control/hosted-review/hosted-review-contracts'

vi.mock('./repository-ref', () => ({
  getGiteaRepoRef: async () => ({
    owner: 'team',
    repo: 'repo',
    apiBaseUrl: 'https://gitea.example/api/v1'
  })
}))

import { createGiteaPullRequest } from './pull-request-creation'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('recovers a created review after an unreadable successful response without hiding rejections', async () => {
  vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://gitea.example/api/v1')
  vi.stubEnv('ORCA_GITEA_TOKEN', 'test-token')
  let createStatus = 201
  let reviewExists = true
  const input: CreateHostedReviewInput = {
    provider: 'gitea',
    base: 'main',
    head: 'feature',
    title: 'A change'
  }
  vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(createStatus === 201 ? '{"number":' : '{"message":"Rejected"}', {
        status: createStatus
      })
    }
    return Response.json(
      reviewExists
        ? [
            {
              number: 17,
              title: 'A change',
              state: 'open',
              html_url: 'https://gitea.example/team/repo/pulls/17',
              head: { ref: 'feature' }
            }
          ]
        : []
    )
  })

  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'already_exists',
    existingReview: { number: 17, url: 'https://gitea.example/team/repo/pulls/17' }
  })
  reviewExists = false
  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'unknown_completion'
  })
  reviewExists = true
  createStatus = 422
  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'validation'
  })
  createStatus = 403
  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'auth_required'
  })
})
