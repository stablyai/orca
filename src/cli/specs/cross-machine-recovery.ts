import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why host: remote selection inputs are accepted and ignored, never an argument error.
const RECOVERY_GLOBAL_FLAGS = [...GLOBAL_FLAGS, 'host']

const LOCAL_ONLY_NOTE =
  'Always targets this computer: --host, --environment, --pairing-code and ORCA_ENVIRONMENT/ORCA_PAIRING_CODE are ignored.'

export const CROSS_MACHINE_RECOVERY_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['recovery', 'describe'],
    summary: 'Describe this host for cross-machine recovery providers',
    usage: 'orca recovery describe --json',
    allowedFlags: [...RECOVERY_GLOBAL_FLAGS],
    notes: [LOCAL_ONLY_NOTE],
    examples: ['orca recovery describe --json']
  },
  {
    path: ['recovery', 'export'],
    summary: "Export a workspace's layout and agent sessions as a recovery descriptor",
    usage: 'orca recovery export --worktree <selector> --json',
    allowedFlags: [...RECOVERY_GLOBAL_FLAGS, 'worktree'],
    notes: [LOCAL_ONLY_NOTE],
    examples: ['orca recovery export --worktree path:/Users/me/repo --json']
  },
  {
    path: ['recovery', 'import'],
    summary: 'Import a recovery descriptor into a restored checkout',
    usage:
      'orca recovery import --descriptor <path|-> --checkout <path> --checkpoint <id> [--path-map <from>=<to>]... [--session-map <from>=<to>]... [--resume <providerSessionId>]... [--resume-key <bindingKeyJson>]... [--prefer-client <clientInstanceId>] [--activate] [--register-repo] [--dry-run] --json',
    allowedFlags: [
      ...RECOVERY_GLOBAL_FLAGS,
      'descriptor',
      'checkout',
      'checkpoint',
      'path-map',
      'session-map',
      'resume',
      'resume-key',
      'prefer-client',
      'activate',
      'register-repo',
      'dry-run'
    ],
    repeatableFlags: ['path-map', 'session-map', 'resume', 'resume-key'],
    notes: [
      LOCAL_ONLY_NOTE,
      'Pass --descriptor - to read the descriptor from stdin; it is refused past 4 MiB.',
      '--resume takes a provider session id that must name exactly one binding; --resume-key takes {"agent","key","id","transcriptPath"?} JSON.'
    ],
    examples: [
      'orca recovery import --descriptor descriptor.json --checkout ~/src/repo --checkpoint 3f2a --resume 8c1e --json'
    ]
  },
  {
    path: ['recovery', 'resume'],
    summary: 'Resume one dormant recovered agent session',
    usage:
      'orca recovery resume --worktree <selector> (--session <providerSessionId> | --resume-key <bindingKeyJson>) [--focus] --json',
    allowedFlags: [...RECOVERY_GLOBAL_FLAGS, 'worktree', 'session', 'resume-key', 'focus'],
    notes: [LOCAL_ONLY_NOTE],
    examples: ['orca recovery resume --worktree path:/Users/me/repo --session 8c1e --json']
  },
  {
    path: ['recovery', 'list'],
    summary: 'List dormant recovered agent sessions',
    usage: 'orca recovery list [--worktree <selector>] --json',
    allowedFlags: [...RECOVERY_GLOBAL_FLAGS, 'worktree'],
    notes: [LOCAL_ONLY_NOTE],
    examples: ['orca recovery list --json']
  },
  {
    path: ['recovery', 'activity'],
    summary: 'Report the latest human input and focus per workspace for capture scheduling',
    usage: 'orca recovery activity --json',
    allowedFlags: [...RECOVERY_GLOBAL_FLAGS],
    notes: [LOCAL_ONLY_NOTE],
    examples: ['orca recovery activity --json']
  }
]
