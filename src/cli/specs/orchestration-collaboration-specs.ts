import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_COLLABORATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'collaboration-publish'],
    summary: 'Publish a collaboration message on a topology topic',
    usage:
      'orca orchestration collaboration-publish --topic <topic> --semantic-type <type> --body <text> [--priority <normal|high|urgent>] [--from <handle>] [--dispatch-capability <capability>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'topic',
      'semantic-type',
      'priority',
      'body',
      'from',
      'dispatch-capability',
      'retry-request'
    ],
    notes: [
      '--priority defaults to normal when omitted.',
      'Subscribers are topology-derived; only Tasks subscribed to the topic in the Run topology receive the publication.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'collaboration-checkpoint'],
    summary: 'Consume the next batch of collaboration messages for this Task',
    usage:
      'orca orchestration collaboration-checkpoint [--limit <n>] [--wait] [--timeout-ms <n>] [--from <handle>] [--dispatch-capability <capability>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'from',
      'limit',
      'wait',
      'timeout-ms',
      'dispatch-capability',
      'retry-request'
    ],
    notes: [
      '--wait is event-driven: it blocks on the mailbox for the next matching message and never polls.',
      'The default server wait budget is 60s when --wait omits --timeout-ms.'
    ]
  },
  {
    path: ['orchestration', 'collaboration-ack'],
    summary: 'Acknowledge collaboration messages consumed by this Task',
    usage:
      'orca orchestration collaboration-ack --message-ids <json_array> [--from <handle>] [--dispatch-capability <capability>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from', 'message-ids', 'dispatch-capability', 'retry-request'],
    notes: ['--message-ids is a JSON array of ids taken from the checkpoint output.']
  }
]
