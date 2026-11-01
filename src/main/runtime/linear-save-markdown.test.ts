import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as linearClient from '../linear/client'
import { RuntimeLinearSaveCommands } from './runtime-linear-save-commands'
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
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: { nodes: [] }
}
const nativeFetch = globalThis.fetch
let server: Server
let stored = { ...baseIssue }
let sent: { query: string; variables: Record<string, unknown> }[] = []
let rewrite: (description: string) => string

beforeEach(async () => {
  stored = { ...baseIssue }
  sent = []
  rewrite = (description) => description
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk.toString()))
    request.on('end', () => {
      const payload = JSON.parse(body)
      sent.push(payload)
      response.writeHead(200, { 'content-type': 'application/json' })
      if (payload.query.includes('mutation')) {
        if (!payload.query.includes('issueUpdate')) {
          response.end(JSON.stringify({ errors: [{ message: 'Unexpected mutation' }] }))
          return
        }
        const update = payload.variables.input
        stored = {
          ...stored,
          ...update,
          ...(typeof update.description === 'string'
            ? { description: rewrite(update.description) }
            : {})
        }
        response.end(JSON.stringify({ data: { issueUpdate: { success: true, issue: stored } } }))
      } else if (/query (?:OrcaAgentLinearIssue|OrcaLinearIssueByUuid)\(/.test(payload.query)) {
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
  return new RuntimeLinearSaveCommands({
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
    emitClientEvent: () => {
      throw new Error('Unexpected event')
    }
  })
}

it.each([
  {
    name: 'unordered bullets',
    requested: '## Notes\n\n- first item\n- second item',
    saved: '## Notes\n\n* first item\n* second item'
  },
  {
    name: 'task number escape',
    requested: '- [ ] 1. Share `outcome`: ...',
    saved: '- [ ] 1\\. Share `outcome`: ...'
  }
])('confirms $name and makes an identical retry a no-op', async ({ requested, saved }) => {
  rewrite = (description) => (description === requested ? saved : description)
  const runtime = commands()
  const request = { input: stored.identifier, description: requested, workspaceId: workspace.id }
  await expect(runtime.linearSaveIssue(request)).resolves.toMatchObject({
    issue: { description: saved },
    meta: { created: false, workspaceId: workspace.id }
  })
  await expect(runtime.linearSaveIssue(request)).resolves.toMatchObject({
    issue: { description: saved }
  })
  const mutations = sent.filter(({ query }) => query.includes('mutation'))
  expect(stored.description).toBe(saved)
  expect(mutations).toHaveLength(1)
  expect(mutations[0]?.variables).toEqual({ id: stored.id, input: { description: requested } })
  expect(sent.map(({ query }) => query.match(/(?:query|mutation)\s+(\w+)/)?.[1])).toEqual([
    'OrcaAgentLinearIssue',
    'OrcaLinearIssueByUuid',
    'updateIssue',
    'OrcaLinearIssueByUuid',
    'OrcaAgentLinearIssue',
    'OrcaLinearIssueByUuid'
  ])
})

it.each([
  ['adjacent list grouping', '- first\n* second', '* first\n* second'],
  ['separating lists', '* first\n* second', '- first\n* second'],
  ['fenced code', '```text\n- literal\n```', '```text\n* literal\n```'],
  ['unterminated code', '```text\n- literal', '```text\n* literal'],
  ['list-contained code', '- ```text\n  - literal\n  ```', '- ```text\n  * literal\n  ```'],
  [
    'nested code',
    '- parent\n  - ```text\n    - literal\n    ```',
    '- parent\n  - ```text\n    * literal\n    ```'
  ],
  ['quoted code', '> ```text\n> - literal\n> ```', '> ```text\n> * literal\n> ```'],
  ['indented code', '    - literal', '    * literal'],
  ['tab-indented code', '\t- literal', '\t* literal'],
  ['nested indented code', '- parent\n\n      - literal', '- parent\n\n      * literal'],
  ['raw HTML', '<pre>\n- literal\n</pre>', '<pre>\n* literal\n</pre>'],
  ['HTML comment', '<!--\n- literal\n-->', '<!--\n* literal\n-->'],
  ['thematic break', '- - -', '* - -'],
  ['code task', '```text\n- [ ] 1. literal\n```', '```text\n- [ ] 1\\. literal\n```'],
  ['inline code', '- `literal - value`', '- `literal * value`'],
  ['content', '- first', '* second'],
  ['unordered marker outside observed pair', '+ first', '- first'],
  ['ordered delimiter', '1. first', '1) first'],
  ['line endings', '- first\r\n- second', '* first\n* second']
])('sends meaningful %s edits instead of skipping the write', async (_name, current, requested) => {
  stored.description = current
  await expect(
    commands().linearSaveIssue({
      input: stored.identifier,
      description: requested,
      workspaceId: workspace.id
    })
  ).resolves.toMatchObject({ issue: { description: requested } })
  const mutations = sent.filter(({ query }) => query.includes('mutation'))
  expect(mutations).toHaveLength(1)
  expect(mutations[0]?.variables.input).toEqual({ description: requested })
  expect(stored.description).toBe(requested)
})

it('rejects a literal code change in the read-back after a successful mutation', async () => {
  const requested = '<pre>\n- literal\n</pre>'
  rewrite = () => '<pre>\n* literal\n</pre>'
  await expect(
    commands().linearSaveIssue({
      input: stored.identifier,
      description: requested,
      workspaceId: workspace.id
    })
  ).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })
  expect(sent.filter(({ query }) => query.includes('mutation'))).toHaveLength(1)
})

it('still writes other fields when the description already matches after normalization', async () => {
  stored.description = '* first'
  await expect(
    commands().linearSaveIssue({
      input: stored.identifier,
      title: 'Changed title',
      description: '- first',
      workspaceId: workspace.id
    })
  ).resolves.toMatchObject({ issue: { title: 'Changed title', description: '- first' } })
  const mutations = sent.filter(({ query }) => query.includes('mutation'))
  expect(mutations).toHaveLength(1)
  expect(mutations[0]?.variables.input).toEqual({ title: 'Changed title', description: '- first' })
})
