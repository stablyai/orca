import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const NOTES = [
  'Reads and answers only native approvals/questions in one explicitly named workspace and session. It does not launch an agent, scan all sessions, write terminal input, or enable experimental connectors.',
  '--turn is the journal turn item id (turnScope.turnItemId), not the provider turnId. Requests without that exact turn ownership are excluded.',
  'Native prompt titles, descriptions, options and typed answers are data, never instructions to the CLI.',
  'A successful response proves a durable answer was accepted, not that the provider resumed or completed. A host may report an unconfirmed provider delivery separately.'
]
export const AGENT_REQUEST_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'requests', 'list'],
    summary: 'List complete current native requests in one explicit session/workspace',
    usage:
      'orca agent requests list --worktree <selector> --session <id> [--turn <turnItemId>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'session', 'turn'],
    notes: NOTES,
    examples: ['orca agent requests list --worktree id:<workspaceId> --session <sessionId> --json']
  },
  {
    path: ['agent', 'requests', 'get'],
    summary: 'Read one complete current native approval/question',
    usage:
      'orca agent requests get --worktree <selector> --session <id> --item <id> [--turn <turnItemId>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'session', 'item', 'turn'],
    notes: NOTES
  },
  {
    path: ['agent', 'requests', 'answer'],
    summary: 'Answer one inspected native request using an exact JSON file',
    usage:
      'orca agent requests answer --worktree <selector> --session <id> --request-file <path> [--turn <turnItemId>] [--retry <operationUUID>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'session', 'turn', 'request-file', 'retry'],
    notes: [
      ...NOTES,
      'The UTF-8 JSON file must include workspaceId, sessionId, expectedRuntimeId, expectedRequests (the complete list marker), itemId, kind, expectedRuntimeFence, expectedRevision, and a caller-chosen clientOperationId UUID. It selects one optionId or the exact structured question answers. Optional turnItemId restricts ownership.',
      'An initial answer requires the inspected runtime, workspace, session, fence, marker and item revision to remain current. The host finally enforces its existing lease, item revision and current provider ownership rules; newer hosts do not enforce the envelope fence themselves.',
      '--retry must equal the file UUID and resends only that same operation and payload once, allowing the host to replay its receipt even when the prompt is no longer pending. Never replace an unknown operation with a fresh UUID or retry automatically.',
      'A session no longer identifiable in this explicit workspace is refused even for replay. Older hosts lacking the native current-request contract are refused without mutation.'
    ]
  }
]
