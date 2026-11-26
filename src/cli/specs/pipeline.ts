import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'
import { PIPELINE_V2_ONLY_COMMANDS } from '../pipeline-v2-command-paths'

const V2_FLAGS = [
  'api-version',
  'project-id',
  'instance-id',
  'runtime-id',
  'request-id',
  'expected-revision',
  'input-file',
  'input-json',
  'cursor',
  'limit',
  'visit-id',
  'visit-cursor',
  'stage-id',
  'invocation-id',
  'artifact-id',
  'artifact-cursor',
  'draft-id',
  'kind',
  'message',
  'action',
  'full',
  'enabled-only'
]

export const PIPELINE_COMMAND_SPECS: CommandSpec[] = [
  ...PIPELINE_V2_ONLY_COMMANDS.map((command) => ({
    path: ['pipeline', ...command.split(' ')],
    summary: `Pipeline v2 ${command}`,
    usage: `orca pipeline ${command} --api-version 2 [--input-file <json> | --input-json <json>] [--json]`,
    allowedFlags: [...LOCAL_COMMAND_FLAGS, ...V2_FLAGS, 'id'],
    ...(command === 'retry'
      ? {
          notes: [
            'Creates a new bounded visit only for a blocked or interrupted stage. It never accepts an owner gate or repeats an uncertain launch. Requires the current project, runtime, workspace instance and expected revision.'
          ]
        }
      : {})
  })),
  ...['list', 'profiles', 'describe'].map((command): CommandSpec => ({
    path: ['pipeline', command],
    summary: `Read pipeline ${command}`,
    usage: `orca pipeline ${command} [--json]`,
    allowedFlags: [...LOCAL_COMMAND_FLAGS, ...V2_FLAGS]
  })),
  ...['status', 'context', 'reconcile'].map((command): CommandSpec => ({
    path: ['pipeline', command],
    summary: `${command === 'reconcile' ? 'Reconcile settled worker evidence for' : 'Read'} a task pipeline`,
    usage: `orca pipeline ${command} --id <run-id> [--json]`,
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      ...V2_FLAGS,
      'id',
      ...(command === 'context' ? ['api-version'] : []),
      ...(command === 'context' ? ['artifact-stage', 'artifact-index'] : []),
      ...(command === 'reconcile' ? ['setup-terminal'] : [])
    ],
    ...(command === 'reconcile'
      ? {
          notes: [
            'With --api-version 2, requires pinned project, runtime, workspace instance, request ID and expected revision. Records only proven completion of the existing invocation; never launches another worker. Recovered evidence settles paused.'
          ]
        }
      : {})
  })),
  ...['pause', 'resume', 'revalidate'].map((command): CommandSpec => ({
    path: ['pipeline', command],
    summary: `${command} a task pipeline at an expected revision`,
    usage: `orca pipeline ${command} --id <run-id> --request-id <unique-id> --expected-revision <revision> [--json]`,
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      ...V2_FLAGS,
      'id',
      'request-id',
      'expected-revision',
      'runtime-id'
    ]
  })),
  {
    path: ['pipeline', 'receipt'],
    summary: 'Read an accepted pipeline request without repeating it',
    usage:
      'orca pipeline receipt --id <run-id> --kind pause|resume|revalidate --request-id <id> --expected-revision <revision> [--runtime-id <id>] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      ...V2_FLAGS,
      'id',
      'kind',
      'request-id',
      'expected-revision',
      'runtime-id'
    ]
  },
  {
    path: ['pipeline', 'submit'],
    summary: 'Submit bounded stage evidence from the assigned worker',
    usage: 'orca pipeline submit --id <run-id> --input-file <mutation.json> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'id', 'input-file', 'api-version'],
    notes: [
      'Only the runtime-attested active worker can submit. Put the JSON file outside the checkout. Use pipeline context to obtain active dispatch, inputRevision, expectedRevision and current sourceRevision.'
    ]
  },
  {
    path: ['pipeline', 'configure'],
    summary: 'Configure trusted literal check argv for a project (owner)',
    usage: 'orca pipeline configure --input-file <checks.json> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'input-file']
  }
]
