import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const MAESTRO_PAYLOAD_FLAGS = [...GLOBAL_FLAGS, 'payload', 'payload-file']

const payloadUsage = '(--payload <json> | --payload-file <path|->)'

export const MAESTRO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['maestro', 'show'],
    summary: 'Read the bounded authorable Maestro document state',
    usage: 'orca maestro show --host <id> --workspace <key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'host', 'workspace'],
    notes: ['This reads document state; use maestro projection show for projected Run state.']
  },
  {
    path: ['maestro', 'watch'],
    summary: 'Read bounded Maestro document deltas',
    usage: `orca maestro watch ${payloadUsage} [--once] [--json]`,
    allowedFlags: [...MAESTRO_PAYLOAD_FLAGS, 'once']
  },
  {
    path: ['maestro', 'apply'],
    summary: 'Apply one revisioned Maestro mutation',
    usage: `orca maestro apply ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'author'],
    summary: 'Apply one revisioned Maestro document authoring mutation',
    usage: `orca maestro author ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'index'],
    summary: 'List bounded Maestro document and projected Run states',
    usage: 'orca maestro index [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Entries label document state and projected Run state separately.']
  },
  {
    path: ['maestro', 'open'],
    summary: 'Focus the exact workspace Maestro Canvas',
    usage: 'orca maestro open (--run <run_id> | --host <id> --workspace <key>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'host', 'workspace'],
    notes: ['--run resolves exactly one authoritative projected Run binding before focus.']
  },
  {
    path: ['maestro', 'projection', 'show'],
    summary: 'Read the current projected Run state',
    usage: 'orca maestro projection show --host <id> --workspace <key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'host', 'workspace'],
    notes: ['--workspace is the public workspaceKey returned by worktree current/show/list.']
  },
  {
    path: ['maestro', 'projection', 'apply'],
    summary: 'Apply one validated projected Run revision',
    usage: `orca maestro projection apply ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'bootstrap'],
    summary: 'Idempotently bootstrap the authoritative Run projection',
    usage: `orca maestro bootstrap ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'workspace-bootstrap-receipt'],
    summary: 'Issue the exact workspace bootstrap receipt for a Run',
    usage:
      'orca maestro workspace-bootstrap-receipt --run <id> --orchestration-home <selector> --execution-workspace <selector> --host <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'orchestration-home', 'execution-workspace', 'host']
  },
  {
    path: ['maestro', 'coordinator-handoff'],
    summary: 'Start or inspect one composed coordinator handoff',
    usage: `orca maestro coordinator-handoff ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'browser-surface', 'open'],
    summary: 'Reserve and open one managed Maestro browser surface',
    usage: `orca maestro browser-surface open ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'browser-surface', 'focus'],
    summary: 'Focus one managed Maestro browser surface',
    usage: `orca maestro browser-surface focus ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'browser-surface', 'capture'],
    summary: 'Capture one managed Maestro browser surface',
    usage: `orca maestro browser-surface capture ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'browser-surface', 'retain'],
    summary: 'Retain one managed Maestro browser surface',
    usage: `orca maestro browser-surface retain ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'browser-surface', 'release'],
    summary: 'Release one managed Maestro browser surface',
    usage: `orca maestro browser-surface release ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'delegate'],
    summary: 'Request one Maestro delegation intent',
    usage: `orca maestro delegate ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'list'],
    summary: 'List available Maestro delegation options',
    usage: `orca maestro list ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'take'],
    summary: 'Take one Maestro delegation intent',
    usage: `orca maestro take ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  },
  {
    path: ['maestro', 'settle'],
    summary: 'Settle one Maestro delegation intent',
    usage: `orca maestro settle ${payloadUsage} [--json]`,
    allowedFlags: MAESTRO_PAYLOAD_FLAGS
  }
]
