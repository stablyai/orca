// OpenAPI 3.1 contract for the public API and the /docs page that renders it. Kept next to the
// router; test/api-openapi.test.ts checks every documented operation is routed and vice versa.
import { API_SCOPES } from './keys'

type Op = {
  summary: string
  description?: string
  scope?: string
  params?: { name: string; in: 'path' | 'query'; description?: string; schema?: object; required?: boolean }[]
  body?: object
  responses: Record<string, string | { description: string; schema: object }>
  tags: string[]
  sessionOnly?: boolean
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const idParam = (name: string, description: string) => ({ name, in: 'path' as const, required: true, description, schema: { type: 'string' } })
const WS = idParam('id', 'Workspace id (sbx_…)')

const schemas: Record<string, object> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string', examples: ['not_found', 'insufficient_scope', 'rate_limited'] }, reason: { type: 'string' } }
  },
  ApiKey: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      prefix: { type: 'string', description: 'Non-secret start of the key, e.g. `orca_sk_Ab3x`' },
      scopes: { type: 'array', items: { type: 'string', enum: [...API_SCOPES] } },
      createdBy: { type: 'string' },
      createdAt: { type: 'integer', description: 'Unix ms' },
      lastUsedAt: { type: ['integer', 'null'] },
      expiresAt: { type: ['integer', 'null'] }
    }
  },
  Project: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      repo: { type: ['object', 'null'], properties: { url: { type: 'string' }, ref: { type: ['string', 'null'] } } },
      environment: {
        type: 'object',
        properties: {
          machineSize: { type: 'string', enum: ['standard', 'large'] },
          region: { type: ['string', 'null'] },
          buildId: { type: ['string', 'null'], description: 'Pinned org environment build; null uses the active build for the repo' }
        }
      },
      createdAt: { type: 'integer' }
    }
  },
  Workspace: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['starting', 'running', 'sleeping', 'waking', 'destroying', 'failed'] },
      archived: { type: 'boolean' },
      hidden: { type: 'boolean', description: 'Routine runs and other machine-made workspaces; excluded from lists unless include=hidden' },
      origin: { type: 'string', enum: ['desktop', 'api', 'mcp', 'routine', 'vm'] },
      machineSize: { type: 'string' },
      region: { type: 'string' },
      repoUrl: { type: ['string', 'null'] },
      session: { type: ['object', 'null'], properties: { startedAt: { type: 'integer' }, leaseExpiresAt: { type: 'integer' } } },
      createdAt: { type: 'integer' }
    }
  },
  Message: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      workspaceId: { type: 'string' },
      agent: { type: 'string', enum: ['claude', 'codex'] },
      status: { type: 'string', enum: ['queued', 'delivering', 'delivered', 'failed'] },
      session: { type: ['string', 'null'], description: 'Agent session that received it; pass as `session` to continue it' },
      error: { type: ['string', 'null'] },
      createdAt: { type: 'integer' },
      deliveredAt: { type: ['integer', 'null'] }
    }
  },
  Session: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      agent: { type: ['string', 'null'] },
      title: { type: ['string', 'null'] },
      connected: { type: 'boolean' },
      lastOutputAt: { type: ['integer', 'null'] },
      preview: { type: ['string', 'null'], description: 'Last few lines of the session' }
    }
  },
  Routine: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      projectId: { type: 'string' },
      enabled: { type: 'boolean' },
      trigger: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'schedule' }, cron: { type: 'string', examples: ['0 9 * * 1-5'] }, timezone: { type: 'string', examples: ['America/New_York'] } } },
          {
            type: 'object',
            properties: {
              kind: { const: 'github' },
              events: { type: 'array', items: { type: 'string', enum: ['pull_request.opened', 'pull_request.labeled', 'pull_request.synchronize', 'issues.opened', 'issues.labeled', 'issue_comment.created'] } },
              labels: { type: 'array', items: { type: 'string' } },
              authors: { type: 'array', items: { type: 'string' } },
              baseBranches: { type: 'array', items: { type: 'string' } }
            }
          },
          { type: 'object', properties: { kind: { const: 'webhook' }, url: { type: 'string', description: 'Secret URL; POST to it to start a run' } } }
        ]
      },
      agent: { type: 'string', enum: ['claude', 'codex'] },
      prompt: { type: 'string' },
      postResults: { type: 'string', enum: ['none', 'comment', 'pr'] },
      nextRunAt: { type: ['integer', 'null'] },
      lastRun: { oneOf: [{ type: 'null' }, ref('RoutineRun')] }
    }
  },
  RoutineRun: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      routineId: { type: 'string' },
      trigger: { type: 'string', enum: ['schedule', 'github', 'webhook', 'manual'] },
      status: { type: 'string', enum: ['queued', 'starting', 'running', 'posting', 'succeeded', 'failed', 'cancelled', 'timed_out'] },
      workspaceId: { type: ['string', 'null'] },
      result: { type: ['object', 'null'], properties: { summary: { type: 'string' }, prUrl: { type: 'string' }, commentUrl: { type: 'string' } } },
      error: { type: ['string', 'null'] },
      createdAt: { type: 'integer' },
      startedAt: { type: ['integer', 'null'] },
      finishedAt: { type: ['integer', 'null'] }
    }
  },
  AuditEntry: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      actor: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' }, userId: { type: ['string', 'null'] } } },
      action: { type: 'string', examples: ['workspace.create', 'api_key.revoke'] },
      target: { type: ['object', 'null'] },
      createdAt: { type: 'integer' }
    }
  }
}

const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', properties, required })
const list = (key: string, item: string) => obj({ [key]: { type: 'array', items: ref(item) } })
const one = (key: string, item: string) => obj({ [key]: ref(item) })

const ROUTINE_BODY = obj(
  {
    name: { type: 'string' },
    projectId: { type: 'string' },
    trigger: (schemas.Routine as { properties: { trigger: object } }).properties.trigger,
    agent: { type: 'string', enum: ['claude', 'codex'] },
    prompt: { type: 'string' },
    postResults: { type: 'string', enum: ['none', 'comment', 'pr'] },
    enabled: { type: 'boolean' }
  },
  ['name', 'projectId', 'trigger', 'prompt']
)

export const OPERATIONS: Record<string, Record<string, Op>> = {
  '/v1/me': {
    get: { tags: ['Account'], summary: 'Who the token acts as', responses: { 200: { description: 'Caller', schema: obj({ accountId: { type: 'string' }, userId: { type: 'string' }, role: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } }) } } }
  },
  '/v1/api-keys': {
    get: { tags: ['API keys'], sessionOnly: true, summary: 'List API keys', description: 'Admins see every key in the org; members see their own.', responses: { 200: { description: 'Keys', schema: list('keys', 'ApiKey') } } },
    post: {
      tags: ['API keys'],
      sessionOnly: true,
      summary: 'Create an API key',
      description: 'The secret is returned once, in this response only. Store it now.',
      body: obj({ name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: [...API_SCOPES] } }, expiresInDays: { type: 'integer', minimum: 1, maximum: 365 } }, ['name', 'scopes']),
      responses: { 201: { description: 'Created', schema: obj({ key: ref('ApiKey'), secret: { type: 'string' } }) } }
    }
  },
  '/v1/api-keys/{id}': {
    delete: { tags: ['API keys'], sessionOnly: true, summary: 'Revoke an API key', params: [idParam('id', 'Key id')], responses: { 200: 'Revoked' } }
  },
  '/v1/settings': {
    get: { tags: ['Account'], summary: 'Programmatic-access settings', responses: { 200: { description: 'Settings', schema: obj({ settings: obj({ vmCliEnabled: { type: 'boolean' } }) }) } } },
    put: { tags: ['Account'], sessionOnly: true, summary: 'Update settings (owner/admin)', body: obj({ vmCliEnabled: { type: 'boolean' } }, ['vmCliEnabled']), responses: { 200: 'Updated' } }
  },
  '/v1/audit': {
    get: {
      tags: ['Account'],
      scope: 'audit:read',
      summary: 'Audit log (owner/admin)',
      params: [
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
        { name: 'before', in: 'query', description: 'Cursor: `nextBefore` from the previous page', schema: { type: 'integer' } }
      ],
      responses: { 200: { description: 'Entries, newest first', schema: obj({ entries: { type: 'array', items: ref('AuditEntry') }, nextBefore: { type: ['integer', 'null'] } }) } }
    }
  },
  '/v1/projects': {
    get: { tags: ['Projects'], scope: 'projects:read', summary: 'List projects', responses: { 200: { description: 'Projects', schema: list('projects', 'Project') } } },
    post: {
      tags: ['Projects'],
      scope: 'projects:write',
      summary: 'Create a project',
      body: obj({ name: { type: 'string' }, repo: obj({ url: { type: 'string' }, ref: { type: 'string' } }, ['url']), environment: obj({ machineSize: { type: 'string' }, region: { type: 'string' }, buildId: { type: 'string' } }) }, ['name']),
      responses: { 201: { description: 'Created', schema: one('project', 'Project') } }
    }
  },
  '/v1/projects/{id}': {
    get: { tags: ['Projects'], scope: 'projects:read', summary: 'Get a project', params: [idParam('id', 'Project id')], responses: { 200: { description: 'Project', schema: one('project', 'Project') } } },
    patch: { tags: ['Projects'], scope: 'projects:write', summary: 'Update a project', params: [idParam('id', 'Project id')], body: obj({ name: { type: 'string' }, repo: { type: 'object' }, environment: { type: 'object' } }), responses: { 200: { description: 'Project', schema: one('project', 'Project') } } },
    delete: { tags: ['Projects'], scope: 'projects:write', summary: 'Delete a project', params: [idParam('id', 'Project id')], responses: { 200: 'Deleted' } }
  },
  '/v1/workspaces': {
    get: {
      tags: ['Workspaces'],
      scope: 'workspaces:read',
      summary: 'List workspaces',
      params: [
        { name: 'include', in: 'query', description: 'Comma list: `hidden` (routine runs), `archived`', schema: { type: 'string' } },
        { name: 'projectId', in: 'query', schema: { type: 'string' } }
      ],
      responses: { 200: { description: 'Workspaces, newest first', schema: list('workspaces', 'Workspace') } }
    },
    post: {
      tags: ['Workspaces'],
      scope: 'workspaces:write',
      summary: 'Create a workspace (boots a VM)',
      description: 'Returns once the VM is running (typically a few seconds). Pass `message` to queue a first prompt for an agent.',
      body: obj({
        name: { type: 'string' },
        projectId: { type: 'string' },
        repo: obj({ url: { type: 'string' }, ref: { type: 'string' } }, ['url']),
        machineSize: { type: 'string', enum: ['standard', 'large'] },
        region: { type: 'string' },
        message: obj({ text: { type: 'string' }, agent: { type: 'string', enum: ['claude', 'codex'] } }, ['text'])
      }),
      responses: { 201: { description: 'Running workspace', schema: obj({ workspace: ref('Workspace'), message: ref('Message') }) } }
    }
  },
  '/v1/workspaces/{id}': {
    get: { tags: ['Workspaces'], scope: 'workspaces:read', summary: 'Workspace status', params: [WS], responses: { 200: { description: 'Workspace', schema: one('workspace', 'Workspace') } } },
    delete: { tags: ['Workspaces'], scope: 'workspaces:write', summary: 'Destroy a workspace (deletes its disk)', params: [WS], responses: { 200: { description: 'Destroyed', schema: one('workspace', 'Workspace') } } }
  },
  '/v1/workspaces/{id}/sleep': {
    post: { tags: ['Workspaces'], scope: 'workspaces:write', summary: 'Sleep: stop the VM, keep the disk', params: [WS], responses: { 200: { description: 'Sleeping', schema: one('workspace', 'Workspace') } } }
  },
  '/v1/workspaces/{id}/wake': {
    post: { tags: ['Workspaces'], scope: 'workspaces:write', summary: 'Wake a sleeping or archived workspace', params: [WS], responses: { 200: { description: 'Running', schema: one('workspace', 'Workspace') } } }
  },
  '/v1/workspaces/{id}/archive': {
    post: { tags: ['Workspaces'], scope: 'workspaces:write', summary: 'Archive: sleep and hide from default lists', params: [WS], responses: { 200: { description: 'Archived', schema: one('workspace', 'Workspace') } } }
  },
  '/v1/workspaces/{id}/messages': {
    get: { tags: ['Agents'], scope: 'workspaces:read', summary: 'Recent messages sent to this workspace', params: [WS], responses: { 200: { description: 'Messages', schema: list('messages', 'Message') } } },
    post: {
      tags: ['Agents'],
      scope: 'messages:write',
      summary: 'Send a message to an agent',
      description: 'Queues the message and returns 202 at once. A sleeping workspace is woken first. Without `session` a new agent session starts with the text as its prompt; with `session` the text is typed into that session. Poll the message for `delivered`.',
      params: [WS],
      body: obj({ text: { type: 'string', maxLength: 32000 }, agent: { type: 'string', enum: ['claude', 'codex'] }, session: { type: 'string' } }, ['text']),
      responses: { 202: { description: 'Queued', schema: one('message', 'Message') } }
    }
  },
  '/v1/workspaces/{id}/messages/{messageId}': {
    get: { tags: ['Agents'], scope: 'workspaces:read', summary: 'Delivery status of a message', params: [WS, idParam('messageId', 'Message id')], responses: { 200: { description: 'Message', schema: one('message', 'Message') } } }
  },
  '/v1/workspaces/{id}/sessions': {
    get: { tags: ['Agents'], scope: 'workspaces:read', summary: 'Agent sessions in a running workspace', params: [WS], responses: { 200: { description: 'Sessions (empty while sleeping)', schema: obj({ workspaceStatus: { type: 'string' }, sessions: { type: 'array', items: ref('Session') } }) } } }
  },
  '/v1/workspaces/{id}/sessions/{handle}': {
    get: {
      tags: ['Agents'],
      scope: 'workspaces:read',
      summary: "An agent session's current screen",
      description: 'What a person looking at the session would see right now (rendered screen, plain text). 409 while the workspace sleeps.',
      params: [WS, idParam('handle', 'Session handle (term_…)')],
      responses: { 200: { description: 'Screen', schema: obj({ session: obj({ handle: { type: 'string' }, status: { type: ['string', 'null'] }, screen: { type: 'string' } }) }) } }
    }
  },
  '/v1/routines': {
    get: { tags: ['Routines'], scope: 'routines:read', summary: 'List routines', responses: { 200: { description: 'Routines', schema: list('routines', 'Routine') } } },
    post: { tags: ['Routines'], scope: 'routines:write', summary: 'Create a routine', description: 'Webhook routines return their secret URL once, in this response.', body: ROUTINE_BODY, responses: { 201: { description: 'Created', schema: one('routine', 'Routine') } } }
  },
  '/v1/routines/{id}': {
    get: { tags: ['Routines'], scope: 'routines:read', summary: 'Get a routine', params: [idParam('id', 'Routine id')], responses: { 200: { description: 'Routine', schema: one('routine', 'Routine') } } },
    patch: { tags: ['Routines'], scope: 'routines:write', summary: 'Update a routine', params: [idParam('id', 'Routine id')], body: ROUTINE_BODY, responses: { 200: { description: 'Routine', schema: one('routine', 'Routine') } } },
    delete: { tags: ['Routines'], scope: 'routines:write', summary: 'Delete a routine', params: [idParam('id', 'Routine id')], responses: { 200: 'Deleted' } }
  },
  '/v1/routines/{id}/run': {
    post: { tags: ['Routines'], scope: 'routines:write', summary: 'Run a routine now', params: [idParam('id', 'Routine id')], responses: { 202: { description: 'Queued run', schema: one('run', 'RoutineRun') } } }
  },
  '/v1/routines/{id}/rotate-webhook': {
    post: { tags: ['Routines'], scope: 'routines:write', summary: 'Rotate the secret webhook URL', description: 'The old URL stops working immediately.', params: [idParam('id', 'Routine id')], responses: { 200: { description: 'New URL', schema: obj({ url: { type: 'string' } }) } } }
  },
  '/v1/routines/{id}/runs': {
    get: { tags: ['Routines'], scope: 'routines:read', summary: 'Run history', params: [idParam('id', 'Routine id')], responses: { 200: { description: 'Runs, newest first', schema: list('runs', 'RoutineRun') } } }
  }
}

export function openApiDocument(origin: string) {
  const paths: Record<string, Record<string, object>> = {}
  for (const [path, methods] of Object.entries(OPERATIONS)) {
    paths[path] = {}
    for (const [method, op] of Object.entries(methods)) {
      const responses: Record<string, object> = {}
      for (const [code, value] of Object.entries(op.responses)) {
        responses[code] = typeof value === 'string' ? { description: value } : { description: value.description, content: { 'application/json': { schema: value.schema } } }
      }
      for (const [code, description] of [['401', 'Missing or invalid token'], ['403', 'Missing scope or role'], ['404', 'Not found (or not yours)'], ['429', 'Rate limited; see Retry-After']] as const) {
        responses[code] = { description, content: { 'application/json': { schema: ref('Error') } } }
      }
      paths[path]![method] = {
        tags: op.tags,
        summary: op.summary,
        ...(op.description || op.scope || op.sessionOnly
          ? { description: [op.description, op.scope ? `Scope: \`${op.scope}\`.` : null, op.sessionOnly ? 'Signed-in session only (API keys cannot manage keys).' : null].filter(Boolean).join('\n\n') }
          : {}),
        operationId: `${method}${path.replace(/\{(\w+)\}/g, 'By_$1').replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
        ...(op.params ? { parameters: op.params } : {}),
        ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
        responses,
        ...(op.scope ? { 'x-orca-scope': op.scope } : {})
      }
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Orca Cloud API',
      version: '1.0.0',
      description:
        'Create and drive Orca Cloud workspaces, message their agents and run routines. Authenticate with `Authorization: Bearer orca_sk_…` (Settings → API keys). Each key is limited to 120 requests a minute; responses carry `x-ratelimit-*` headers.'
    },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An Orca API key (`orca_sk_…`) or an OAuth access token issued to an MCP client' } },
      schemas
    },
    tags: [
      { name: 'Workspaces', description: 'Cloud VMs: create, sleep, wake, archive, destroy' },
      { name: 'Agents', description: 'Message agents and list their sessions' },
      { name: 'Routines', description: 'Scheduled, GitHub-triggered and webhook-triggered agent runs in fresh VMs' },
      { name: 'Projects', description: 'A repo plus the environment workspaces start from' },
      { name: 'API keys', description: 'Org-scoped keys, hashed at rest' },
      { name: 'Account', description: 'Settings and audit log' }
    ],
    paths
  }
}

export function docsPage(origin: string): Response {
  const esc = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const o = esc(origin)
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orca Cloud API</title>
<style>
:root{color-scheme:light dark;--fg:#16161a;--muted:#5f6068;--bg:#fff;--card:#f6f6f8;--line:#e3e3e8;--accent:#3b5bfd}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a0a1ab;--bg:#111114;--card:#1a1a1f;--line:#2a2a31;--accent:#8ea2ff}}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:860px;margin:0 auto;padding:48px 24px 24px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}p{color:var(--muted);margin:6px 0}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card b{display:block;margin-bottom:2px}
</style></head><body><main>
<h1>Orca Cloud API</h1>
<p>Create cloud workspaces, message their agents, and run routines from scripts, CI and MCP clients. Base URL <code>${o}</code>. Machine-readable spec: <a href="/v1/openapi.json">/v1/openapi.json</a>.</p>
<h2>Authenticate</h2>
<p>Create a key in Orca → Settings → API keys. Keys belong to your org, carry scopes, and are shown once.</p>
<pre>export ORCA_API_KEY=orca_sk_…
curl -s ${o}/v1/me -H "Authorization: Bearer $ORCA_API_KEY"</pre>
<h2>Start a workspace and give an agent a task</h2>
<pre>curl -s ${o}/v1/workspaces -H "Authorization: Bearer $ORCA_API_KEY" -H 'content-type: application/json' \\
  -d '{"name":"fix-flaky-test","repo":{"url":"https://github.com/acme/app"},
       "message":{"agent":"claude","text":"Find and fix the flaky checkout test, then open a PR."}}'</pre>
<p>The call returns when the VM is running. The message is queued and delivered in the background; poll <code>GET /v1/workspaces/{id}/messages/{messageId}</code>.</p>
<h2>Sleep, wake, archive, destroy</h2>
<pre>curl -X POST ${o}/v1/workspaces/$ID/sleep   -H "Authorization: Bearer $ORCA_API_KEY"
curl -X POST ${o}/v1/workspaces/$ID/wake    -H "Authorization: Bearer $ORCA_API_KEY"
curl -X POST ${o}/v1/workspaces/$ID/archive -H "Authorization: Bearer $ORCA_API_KEY"
curl -X DELETE ${o}/v1/workspaces/$ID       -H "Authorization: Bearer $ORCA_API_KEY"</pre>
<h2>MCP</h2>
<p>Point any MCP client at <code>${o}/mcp</code>. Clients that support OAuth sign in through the browser; others can send an API key as a bearer token.</p>
<pre>claude mcp add --transport http orca-cloud ${o}/mcp</pre>
<h2>Limits and errors</h2>
<div class="grid">
<div class="card"><b>Rate limits</b>120 requests/min per key, 30 messages/min per user, 10 workspace creates/min per org. 429 responses carry <code>Retry-After</code>.</div>
<div class="card"><b>Errors</b>JSON <code>{"error":"code","reason":"…"}</code>. Another org's resources answer 404, never 403.</div>
<div class="card"><b>Audit</b>Every mutation is recorded. Owners and admins can read <code>GET /v1/audit</code>.</div>
</div>
<h2>Reference</h2>
</main>
<script id="api-reference" data-url="/v1/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
</body></html>`
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net https://fonts.scalar.com data:; img-src data: https:; connect-src 'self'"
    }
  })
}
