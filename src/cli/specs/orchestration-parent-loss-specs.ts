import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_PARENT_LOSS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'parent-checkpoint'],
    summary: 'Persist a frozen worker checkpoint before rebind',
    usage:
      'orca orchestration parent-checkpoint --dispatch <dispatch_id> --old-parent <handle> --checkpoint-state <json> [--from <worker_handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'dispatch',
      'old-parent',
      'checkpoint-state',
      'from',
      'retry-request'
    ],
    notes: ['This records state only; it does not promote, rebind, or restart the worker.']
  },
  {
    path: ['orchestration', 'parent-rebind'],
    summary: 'Apply one explicitly approved parent rebind',
    usage:
      'orca orchestration parent-rebind --checkpoint <checkpoint_id> --new-parent <handle> --new-parent-pane-key <pane_key> --approved-by <identity> --approval-id <id> [--lease-ms <n>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'checkpoint',
      'new-parent',
      'new-parent-pane-key',
      'approved-by',
      'approval-id',
      'lease-ms',
      'retry-request'
    ],
    notes: [
      'Creates a new Dispatch, coordinator epoch, and correlation ID. The old Dispatch is never reused.',
      'Approval fields are mandatory audit evidence; automatic cross-plane fallback is not supported.'
    ]
  }
]
