import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../shared/linear/issue-types'
import { getIssue } from './linear-issue-lookups'
import { acquire, release } from './linear-request-concurrency'
import { loadLinearSdk } from './linear-sdk'

const mocks = vi.hoisted(() => ({ getClients: vi.fn(), signing: vi.fn(), map: vi.fn() }))
vi.mock('./client', () => ({
  getClients: mocks.getClients,
  getPublicFileUrlClient: mocks.signing,
  isAuthError: () => false
}))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./linear-issue-query-support', () => ({ mapIssueForWorkspace: mocks.map }))

const issue: LinearIssue = {
  id: 'issue',
  identifier: 'ENG-1',
  title: 'Task',
  url: 'https://linear.app/acme/issue/ENG-1/task',
  workspaceId: 'workspace',
  state: { name: 'Todo', type: 'unstarted', color: '' },
  team: { id: 'team', name: 'Engineering', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-10-08'
}
let server: Server
let apiUrl = ''
let responses: ServerResponse[]
let received: () => void
let answer = false
let signingOnly = false
let deadlines: (() => void)[]
const nativeSetTimeout = globalThis.setTimeout
const nativeFetch = globalThis.fetch

beforeEach(async () => {
  vi.clearAllMocks()
  responses = []
  received = () => {}
  answer = false
  signingOnly = false
  deadlines = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk.toString()))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
      if (answer && (!signingOnly || !body.includes('OrcaLinearDescriptionImages'))) {
        response.end(
          JSON.stringify({
            data: { issue: { id: issue.id, sharedAccess: { sharedWithUsers: [] }, reactions: [] } }
          })
        )
      } else {
        responses.push(response)
        received()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address')
  }
  apiUrl = `http://127.0.0.1:${address.port}/graphql`
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => nativeFetch(apiUrl, init))
  mocks.getClients.mockImplementation((_workspace: unknown, signal: AbortSignal) => [
    {
      workspace: { id: 'workspace' },
      apiKey: 'probe-only',
      client: new (loadLinearSdk().LinearClient)({ apiKey: 'probe-only', signal })
    }
  ])
  mocks.signing.mockImplementation(
    (_entry: unknown, signal: AbortSignal) =>
      new (loadLinearSdk().LinearClient)({ apiKey: 'probe-only', signal })
  )
  mocks.map.mockResolvedValue(issue)
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 30_000) {
      deadlines.push(() => callback(...args))
    }
    return nativeSetTimeout(callback, delay, ...args)
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  server.closeAllConnections()
  await closed
})

function waitForRequests(count: number): Promise<void> {
  return new Promise((resolve) => {
    received = () => {
      if (responses.length === count) {
        resolve()
      }
    }
  })
}

it('aborts real SDK response bodies before freeing native permits, then admits a healthy read', async () => {
  const started = waitForRequests(4)
  const reads = Array.from({ length: 4 }, () =>
    getIssue('ENG-1', 'workspace').catch((error) => error)
  )
  await started
  expect(responses).toHaveLength(4)
  let admitted = false
  const nextAdmission = acquire().then(() => {
    admitted = true
    release()
  })
  await Promise.resolve()
  expect(responses).toHaveLength(4)
  expect(admitted).toBe(false)
  expect(deadlines).toHaveLength(4)
  for (const deadline of deadlines) {
    deadline()
  }
  expect(admitted).toBe(false)
  for (const result of await Promise.all(reads)) {
    expect(result).toEqual(new Error('Linear issue detail lookup timed out'))
  }
  expect(responses).toHaveLength(4)
  await nextAdmission
  expect(admitted).toBe(true)
  expect(mocks.getClients.mock.calls.map((call) => call[1].aborted)).toEqual([
    true,
    true,
    true,
    true
  ])
  answer = true
  await expect(getIssue('ENG-3', 'workspace')).resolves.toEqual(issue)
})

it('removes expired queued admission without spending or releasing a running permit', async () => {
  await Promise.all(Array.from({ length: 4 }, () => acquire()))
  try {
    const queued = getIssue('ENG-1', 'workspace').catch((error) => error)
    expect(deadlines).toHaveLength(1)
    deadlines[0]()
    expect(await queued).toEqual(new Error('Linear issue detail lookup timed out'))
    expect(responses).toEqual([])
  } finally {
    for (let index = 0; index < 4; index++) {
      release()
    }
  }
  answer = true
  await expect(getIssue('ENG-2', 'workspace')).resolves.toEqual(issue)
})

it('uses the same deadline for a real SDK image-signing body and rejects a partial detail', async () => {
  answer = true
  signingOnly = true
  mocks.map.mockResolvedValue({
    ...issue,
    description: '![Upload](https://uploads.linear.app/w/image)'
  })
  const started = waitForRequests(1)
  const read = getIssue('ENG-1', 'workspace').catch((error) => error)
  await started
  expect(mocks.signing.mock.calls[0][1]).toBe(mocks.getClients.mock.calls[0][1])
  expect(deadlines).toHaveLength(1)
  deadlines[0]()
  expect(await read).toEqual(new Error('Linear issue detail lookup timed out'))
  signingOnly = false
  await expect(getIssue('ENG-2', 'workspace')).resolves.toEqual(
    expect.objectContaining({ id: issue.id })
  )
})
