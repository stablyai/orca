import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as linearClient from '../linear/client'
import { RuntimeLinearSaveCommands } from './integrations/linear/runtime-linear-save-commands'
import { loadLinearSdk } from '../linear/linear-sdk'

const boundary = vi.hoisted(() => ({ clients: vi.fn(), status: vi.fn(), signing: vi.fn() }))
vi.mock('../linear/client', async (importOriginal) => ({
  ...(await importOriginal<typeof linearClient>()),
  getClients: boundary.clients,
  getStatus: boundary.status,
  getPublicFileUrlClient: boundary.signing
}))

const workspace = {
  id: 'workspace-proof',
  organizationId: 'org-proof',
  organizationName: 'Local proof',
  organizationUrlKey: 'local-proof',
  name: 'Proof',
  email: 'proof@example.invalid',
  viewerId: 'viewer-proof',
  displayName: 'Proof'
}
function initialCycle(): { id: string; name: string; number: number } | null {
  return null
}
const baseIssue = {
  id: '00000000-0000-4000-8000-000000000001',
  identifier: 'PROOF-1',
  title: 'Existing title',
  description: 'Existing description',
  url: 'https://linear.app/local-proof/issue/PROOF-1',
  team: { id: 'team-proof', key: 'PROOF', name: 'Proof' },
  state: { id: 'state-proof', name: 'Todo' },
  parent: null,
  project: null,
  cycle: initialCycle(),
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  reactions: [],
  sharedAccess: {
    isShared: false,
    sharedWithCount: 0,
    viewerHasOnlySharedAccess: false,
    disallowedIssueFields: [],
    sharedWithUsers: []
  },
  labelIds: [],
  labels: { nodes: [] }
}
const nativeFetch = globalThis.fetch
let server: Server
let stored = { ...baseIssue }
let sent: { query: string; variables: Record<string, unknown> }[] = []
const cycle = { id: '00000000-0000-4000-8000-000000000099', name: 'Sprint', number: 9 }
let availableCycles = [cycle]
let ignoreAssignment = false

beforeEach(async () => {
  stored = { ...baseIssue }
  sent = []
  availableCycles = [cycle]
  ignoreAssignment = false
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk.toString()))
    request.on('end', () => {
      const payload = JSON.parse(body)
      sent.push(payload)
      response.writeHead(200, { 'content-type': 'application/json' })
      if (payload.query.includes('mutation')) {
        const input = payload.variables.input
        const create = payload.query.includes('issueCreate')
        stored = {
          ...stored,
          ...(input.id ? { id: input.id } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(!ignoreAssignment && input.cycleId !== undefined
            ? { cycle: input.cycleId === null ? null : cycle }
            : {})
        }
        response.end(
          JSON.stringify({
            data: {
              [create ? 'issueCreate' : 'issueUpdate']: { success: true, issue: stored }
            }
          })
        )
      } else if (payload.query.includes('cycles(')) {
        const filter = payload.variables.filter
        const nodes =
          filter.team.id.eq === 'team-proof'
            ? availableCycles.filter((entry) => !filter.id || entry.id === filter.id.eq)
            : []
        response.end(
          JSON.stringify({
            data: {
              cycles: {
                nodes,
                pageInfo: {
                  hasNextPage: false,
                  hasPreviousPage: false,
                  endCursor: null,
                  startCursor: null
                }
              }
            }
          })
        )
      } else if (
        /query (?:OrcaAgentLinearIssue|OrcaLinearIssueByUuid|issue)\(/.test(payload.query)
      ) {
        response.end(JSON.stringify({ data: { issue: stored } }))
      } else {
        response.end(JSON.stringify({ errors: [{ message: 'Unexpected query' }] }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No localhost address')
  }
  const apiUrl = `http://127.0.0.1:${address.port}/graphql`
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => nativeFetch(apiUrl, init))
  const createClient = (signal?: AbortSignal) =>
    new (loadLinearSdk().LinearClient)({ apiKey: 'local-proof-only', signal })
  boundary.clients.mockImplementation((_workspace, signal) => [
    { workspace, apiKey: 'local-proof-only', client: createClient(signal) }
  ])
  boundary.signing.mockImplementation((_entry, signal) => createClient(signal))
  boundary.status.mockReturnValue({ connected: true, workspaces: [workspace] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  server.closeAllConnections()
  await closed
})

function commands() {
  const runtime = new RuntimeLinearSaveCommands({
    runtimeAvailable: () => true,
    showTerminal: async () => {
      throw new Error('No terminal in HTTP proof')
    },
    resolveWorkspaceSelector: async () => {
      throw new Error('No workspace resolution in HTTP proof')
    },
    listResolvedWorktrees: async () => [],
    setWorktreeMeta: () => {
      throw new Error('Unexpected workspace metadata write')
    },
    emitClientEvent: () => {}
  })
  vi.spyOn(runtime, 'resolveLinearCreateTeam').mockResolvedValue({
    ...baseIssue.team,
    workspaceId: workspace.id
  })
  return runtime
}

it('assigns the current cycle in the initial create and returns it', async () => {
  const result = await commands().linearSaveIssue({
    team: 'PROOF',
    title: 'New',
    cycle: 'current',
    workspaceId: workspace.id
  })
  expect(result.issue.cycle).toEqual({
    id: '00000000-0000-4000-8000-000000000099',
    name: 'Sprint',
    number: 9
  })
  expect(sent.find(({ query }) => query.includes('issueCreate'))?.variables.input).toMatchObject({
    cycleId: '00000000-0000-4000-8000-000000000099'
  })
})

it('assigns by ID, preserves an omitted cycle, and explicitly clears it', async () => {
  const runtime = commands()
  const target = { input: 'PROOF-1', workspaceId: workspace.id }
  await runtime.linearSaveIssue({ ...target, cycle: '00000000-0000-4000-8000-000000000099' })
  expect(stored.cycle?.id).toBe('00000000-0000-4000-8000-000000000099')
  await runtime.linearSaveIssue({ ...target, title: 'Renamed' })
  expect(stored.cycle?.id).toBe('00000000-0000-4000-8000-000000000099')
  await runtime.linearSaveIssue({ ...target, cycle: null })
  expect(stored.cycle).toBeNull()
})

it.each(['missing', 'ambiguous', 'other team'])(
  'refuses %s cycles before writing',
  async (kind) => {
    availableCycles = kind === 'ambiguous' ? [cycle, { ...cycle, id: 'other' }] : []
    await expect(
      commands().linearSaveIssue({
        team: 'PROOF',
        title: 'New',
        workspaceId: workspace.id,
        cycle: kind === 'other team' ? '00000000-0000-4000-8000-000000000088' : 'current'
      })
    ).rejects.toThrow()
    expect(sent.some(({ query }) => query.includes('mutation'))).toBe(false)
  }
)

it('does not report success when Linear fails to retain the requested cycle', async () => {
  ignoreAssignment = true
  await expect(
    commands().linearSaveIssue({ input: 'PROOF-1', cycle: 'current', workspaceId: workspace.id })
  ).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })
})
