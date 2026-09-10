import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_SEND_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'send'],
  summary: 'Send input to a live terminal',
  usage:
    'orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--lease-input <json>] [--wait-submit <seconds>] [--retry-request <id>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'text',
    'enter',
    'interrupt',
    'lease-input',
    'wait-submit',
    'retry-request'
  ],
  notes: [
    'For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.',
    '--wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.',
    '--lease-input JSON fields: commandId, idempotencyKey, contentDigest (sha256:<64 lowercase hex>), enqueueSequence, leaseId, authority (coordinator|worker|user), runId, coordinatorGeneration, expectedLifecycleState, observedInputSurface (ready_prompt|working|permission|input_required), expiresAt (ISO 8601), and expectedGraphRevision.',
    'The lease envelope is bound to the exact terminal, workspace, Run generation, content digest, and caller authority; copy it from the owning orchestration receipt instead of reconstructing identities.',
    'A managed terminal that is working, awaiting permission, or awaiting input rejects agent lease input with accepted false and rejectionCode input_surface_not_ready; no payload is queued.',
    'After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.',
    'Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.'
  ]
}
