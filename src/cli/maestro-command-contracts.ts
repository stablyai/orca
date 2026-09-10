import { z } from 'zod'
import { MaestroBootstrapRequestSchema } from '../shared/maestro-bootstrap-contract'
import {
  MaestroBrowserSurfaceActionRequestSchema,
  MaestroBrowserSurfaceReleaseRequestSchema,
  MaestroBrowserSurfaceRequestSchema
} from '../shared/maestro-browser-surface'
import {
  AgentGraphViewSchema,
  MaestroDocumentAuthoringMutationSchema,
  MaestroMutationSchema,
  MaestroWorkspaceAnchorSchema
} from '../shared/maestro-contract'
import {
  MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY,
  MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
  MAESTRO_RUNTIME_CAPABILITY
} from '../shared/protocol-version'

export const MaestroProjectionApplyParamsSchema = z
  .object({
    workspace: MaestroWorkspaceAnchorSchema,
    view: AgentGraphViewSchema
  })
  .strict()

const JSON_SCHEMA_OPTIONS = { io: 'input' } as const

const BrowserManagedPageTargetSchema = z
  .object({
    page: z.string().min(1).max(4096),
    worktree: z.string().min(1).max(4096).optional()
  })
  .strict()

const BrowserManagedPageClickSchema = BrowserManagedPageTargetSchema.extend({
  element: z.string().min(1).max(4096)
}).strict()

function payloadFileExample(command: string, payload: string): string {
  return [`orca ${command} --payload-file - --json <<'JSON'`, payload, 'JSON'].join('\n')
}

const BROWSER_WORKSPACE =
  '"workspace":{"repository_id":"workspace_1","execution_host_id":"local","workspace_key":"folder:workspace_1","run_id":"run_1"}'
const BROWSER_ACTOR =
  '"actor":{"actor_id":"worker_1","kind":"worker","authenticated":true,"session_id":"session_1"}'
const BROWSER_ACTION = `{"schema_version":1,"protocol":"maestro-browser-surface/v1",${BROWSER_WORKSPACE},${BROWSER_ACTOR},"coordinator_generation":1,"surface_id":"browser-surface-request_1"}`

export const MAESTRO_AGENT_PAYLOAD_CONTRACTS = {
  'maestro apply': {
    schema: z.toJSONSchema(MaestroMutationSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_RUNTIME_CAPABILITY],
    preconditions: ['The authenticated actor may mutate the exact active Run workspace.'],
    stdinExample: 'orca maestro apply --payload-file - --json'
  },
  'maestro author': {
    schema: z.toJSONSchema(MaestroDocumentAuthoringMutationSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_RUNTIME_CAPABILITY],
    preconditions: ['The current projection anchor authorizes the document mutation.'],
    stdinExample: 'orca maestro author --payload-file - --json'
  },
  'maestro projection apply': {
    schema: z.toJSONSchema(MaestroProjectionApplyParamsSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_RUNTIME_CAPABILITY],
    preconditions: ['Only the current coordinator may publish a validated projection revision.'],
    stdinExample: 'orca maestro projection apply --payload-file - --json'
  },
  'maestro bootstrap': {
    schema: z.toJSONSchema(MaestroBootstrapRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY],
    preconditions: [
      'Use the exact execution host, public workspaceKey, active Run, and coordinator generation.'
    ],
    stdinExample: [
      "orca maestro bootstrap --payload-file - --json <<'JSON'",
      '{"schema_version":1,"protocol":"maestro-bootstrap/v1","mutation":{"mutation_id":"mutation_1","execution_host_id":"local","workspace_key":"folder:workspace_1","run_id":"run_1"},"coordinator_generation":1}',
      'JSON'
    ].join('\n')
  },
  'maestro browser-surface open': {
    schema: z.toJSONSchema(MaestroBrowserSurfaceRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: [
      'A coordinator may manage the Run; a worker may create only a harness-owned surface for its exact active Task and Dispatch, using the Dispatch ID as attempt_id.'
    ],
    stdinExample: payloadFileExample(
      'maestro browser-surface open',
      `{"schema_version":1,"protocol":"maestro-browser-surface/v1","request_id":"request_1",${BROWSER_WORKSPACE},${BROWSER_ACTOR},"coordinator_generation":1,"task_id":"task_1","attempt_id":"dispatch_1","agent_id":"worker","url":"https://example.com","title":"Research","profile_id":null,"requested_visibility":"visible","viewport":{"width":1440,"height":900,"device_scale_factor":1},"retention":"release_when_settled","ownership":"harness","evidence":{"route_or_component":"Research","state":"open","theme":"dark","source_revision":"revision_1","capture_mode":"native-viewport"}}`
    )
  },
  'maestro browser-surface focus': {
    schema: z.toJSONSchema(MaestroBrowserSurfaceActionRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['A worker may focus only a surface it owns while its Dispatch is active.'],
    stdinExample: payloadFileExample('maestro browser-surface focus', BROWSER_ACTION)
  },
  'maestro browser-surface capture': {
    schema: z.toJSONSchema(MaestroBrowserSurfaceActionRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['A worker may capture only a surface it owns while its Dispatch is active.'],
    stdinExample: payloadFileExample('maestro browser-surface capture', BROWSER_ACTION)
  },
  'maestro browser-surface retain': {
    schema: z.toJSONSchema(MaestroBrowserSurfaceActionRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['A worker may retain only a surface it owns while its Dispatch is active.'],
    stdinExample: payloadFileExample('maestro browser-surface retain', BROWSER_ACTION)
  },
  'maestro browser-surface release': {
    schema: z.toJSONSchema(MaestroBrowserSurfaceReleaseRequestSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['A worker may release only a surface it owns while its Dispatch is active.'],
    stdinExample: payloadFileExample(
      'maestro browser-surface release',
      `{"schema_version":1,"protocol":"maestro-browser-surface/v1","request_id":"release_1",${BROWSER_WORKSPACE},${BROWSER_ACTOR},"coordinator_generation":1,"surface_id":"browser-surface-request_1","reason":"Task complete"}`
    )
  },
  snapshot: {
    schema: z.toJSONSchema(BrowserManagedPageTargetSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['Use the exact Browser page identity returned by the managed surface.'],
    stdinExample: 'orca snapshot --page browser-page-id --json'
  },
  click: {
    schema: z.toJSONSchema(BrowserManagedPageClickSchema, JSON_SCHEMA_OPTIONS),
    requiredCapabilities: [MAESTRO_BROWSER_SURFACE_RUNTIME_CAPABILITY],
    preconditions: ['Use an element ref from the exact managed Browser page snapshot.'],
    stdinExample: 'orca click --page browser-page-id --element e1 --json'
  }
} as const

export type MaestroAgentPayloadContracts = typeof MAESTRO_AGENT_PAYLOAD_CONTRACTS
