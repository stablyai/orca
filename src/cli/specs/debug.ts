import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const WORKTREE_NOTE =
  'Without --worktree, targets the worktree containing the current directory. Remote calls need an explicit --worktree.'
const REFUSAL_NOTE =
  'A refusal (for example human-session when a person started the session) prints its reason and exits 1.'

export const DEBUG_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['debug', 'status'],
    summary: "Show the worktree's debug session status in one line",
    usage: 'orca debug status [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [WORKTREE_NOTE, 'Use --json for threads, breakpoints and the stopped reason.'],
    examples: ['orca debug status', 'orca debug status --worktree active --json']
  },
  {
    path: ['debug', 'configs'],
    summary: "List the worktree's launch configurations and whether each can run",
    usage: 'orca debug configs [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [WORKTREE_NOTE, 'Reads .vscode/launch.json; a non-runnable entry shows why.'],
    examples: ['orca debug configs --json']
  },
  {
    path: ['debug', 'start'],
    summary: 'Start debugging with a launch configuration',
    usage:
      'orca debug start [--config <name>] [--file <path>] [--line <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'config', 'file', 'line'],
    notes: [
      "Runs only a launch configuration (and adapter) a person has already approved by starting it once in Orca's Run and Debug tab. Anything else is refused (launch-not-approved).",
      'That approval binds the configuration, not the program: an approved "Debug current file" (${file}) configuration lets an agent debug any file you pass with --file, in any worktree of that repo.',
      'Prints a control seq; a following `orca debug wait` already counts from it.',
      'Without --config, the default configuration is used. A relative --file resolves against the worktree.',
      'One session per worktree: starting while one is live is refused (already-debugging).',
      WORKTREE_NOTE
    ],
    examples: ['orca debug start --config "Python: Current File" --file src/main.py']
  },
  {
    path: ['debug', 'stop'],
    summary: "Stop the worktree's debug session",
    usage: 'orca debug stop [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      "An agent may stop only a session it started; a person's is refused (human-session).",
      WORKTREE_NOTE
    ],
    examples: ['orca debug stop']
  },
  {
    path: ['debug', 'restart'],
    summary: "Restart the worktree's debug session with the same configuration",
    usage: 'orca debug restart [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [WORKTREE_NOTE, REFUSAL_NOTE],
    examples: ['orca debug restart']
  },
  {
    path: ['debug', 'continue'],
    summary: 'Resume a stopped thread',
    usage: 'orca debug continue [--thread <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'thread'],
    notes: ['Without --thread, acts on the stopped thread.', REFUSAL_NOTE],
    examples: ['orca debug continue', 'orca debug continue --thread 2']
  },
  {
    path: ['debug', 'pause'],
    summary: 'Pause a running thread',
    usage: 'orca debug pause [--thread <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'thread'],
    notes: ['Without --thread, pauses the first thread.', REFUSAL_NOTE],
    examples: ['orca debug pause']
  },
  {
    path: ['debug', 'step'],
    summary: 'Step a stopped thread over, into, or out of the current line',
    usage: 'orca debug step --over|--into|--out [--thread <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'thread', 'over', 'into', 'out'],
    notes: [
      'Pass exactly one of --over, --into, --out.',
      'Without --thread, acts on the stopped thread. Follow with `orca debug wait` to block until it stops again.'
    ],
    examples: ['orca debug step --over', 'orca debug step --into --thread 1']
  },
  {
    path: ['debug', 'stack'],
    summary: 'Print the call stack of a stopped thread',
    usage: 'orca debug stack [--thread <id>] [--levels <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'thread', 'levels'],
    notes: [
      'Prints one frame per line as `#n name  path:line`. --levels caps the frames (max 200).',
      'Use the frame ids from --json with `orca debug vars --frame` and `orca debug eval --frame`.'
    ],
    examples: ['orca debug stack', 'orca debug stack --levels 5 --json']
  },
  {
    path: ['debug', 'vars'],
    summary: 'Print the local variables of a stack frame as a tree',
    usage:
      'orca debug vars [--frame <id>] [--ref <variablesReference>] [--depth <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'frame', 'ref', 'depth'],
    notes: [
      'Without --frame, reads the locals of the top frame of the stopped thread.',
      '--ref expands one variable by its variablesReference instead. --depth nests children (0-3, default 1).'
    ],
    examples: ['orca debug vars', 'orca debug vars --frame 3 --depth 2 --json']
  },
  {
    path: ['debug', 'eval'],
    summary: 'Evaluate an expression in a stopped frame',
    usage: 'orca debug eval <expression> [--frame <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'expression', 'frame'],
    positionalArgs: ['expression'],
    notes: [
      'Pass the expression positionally or as --expression. Without --frame, evaluates in the top frame.',
      'Evaluation runs code in the program; it is refused in a session a person started (human-session).'
    ],
    examples: ['orca debug eval "len(items)"', 'orca debug eval --expression "user.id" --frame 3']
  },
  {
    path: ['debug', 'events'],
    summary: 'Read debug output and state changes after a sequence number',
    usage: 'orca debug events [--since <seq>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'since'],
    notes: [
      'Pass the latestSeq from the previous call as --since to read only newer events. Defaults to 0.',
      'Events come from a bounded ring; truncated: true means some events after --since were evicted.'
    ],
    examples: ['orca debug events', 'orca debug events --since 42 --json']
  },
  {
    path: ['debug', 'wait'],
    summary: 'Block until the debug session stops (for example at a breakpoint) or ends',
    usage:
      'orca debug wait [--for stopped|terminated|either] [--since <seq>] [--timeout-ms <ms>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'for', 'since', 'timeout-ms'],
    notes: [
      'This is how an agent blocks until a breakpoint is hit: start or continue, then wait.',
      'Counts from your last start, restart, continue, step or pause, so a stop that happened before wait was called still satisfies it. --since <seq> counts from another control seq instead. --for defaults to stopped.',
      '--timeout-ms defaults to 30000 (max 120000). A timeout prints the current status and exits 1.'
    ],
    examples: [
      'orca debug wait --json',
      'orca debug wait --for either --timeout-ms 60000',
      'orca debug continue && orca debug wait && orca debug stack'
    ]
  },
  {
    path: ['debug', 'break', 'list'],
    summary: "List the worktree's breakpoints",
    usage: 'orca debug break list [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Breakpoints persist per worktree and apply to every session.',
      'A condition, hit condition or log message an agent set is withheld from a session a person started; that breakpoint shows (agent-written condition withheld).',
      WORKTREE_NOTE
    ],
    examples: ['orca debug break list --json']
  },
  {
    path: ['debug', 'break', 'add'],
    summary: 'Add a breakpoint, optionally conditional or a logpoint',
    usage:
      'orca debug break add --path <path> --line <n> [--condition <expr>] [--hit-condition <expr>] [--log-message <text>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'worktree',
      'path',
      'line',
      'condition',
      'hit-condition',
      'log-message'
    ],
    notes: [
      'A relative --path resolves against the worktree; paths outside it are refused. At most 1000 breakpoints per worktree (too-many-breakpoints).',
      '--log-message makes a logpoint: it prints instead of stopping (read it with `orca debug events`).'
    ],
    examples: [
      'orca debug break add --path src/app.py --line 42',
      'orca debug break add --path src/app.py --line 42 --condition "count > 3"'
    ]
  },
  {
    path: ['debug', 'break', 'rm'],
    summary: 'Remove the breakpoints at a file and line',
    usage: 'orca debug break rm --path <path> --line <n> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'path', 'line'],
    notes: [
      'A relative --path resolves against the worktree.',
      'A breakpoint a person set cannot be removed by an agent (human-session).'
    ],
    examples: ['orca debug break rm --path src/app.py --line 42']
  }
]
