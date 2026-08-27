import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/** Correction 2 — the durable wait and the bounded control-plane operations. */
export const ORCHESTRATION_CONTROL_PLANE_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'await'],
    summary: 'Subscribe once and yield until the runtime has a real wake event',
    usage:
      'orca orchestration await [--ack <delivery_id>] [--run <run_id>] [--from <handle>] [--timeout-ms <n>] [--sweep-interval-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ack', 'run', 'from', 'timeout-ms', 'sweep-interval-ms'],
    notes: [
      'The runtime owns this wait for hours (default 6h, max 24h) and re-arms its own internal slices; it is not a 25/30/60-second continuation loop.',
      'It returns only for worker_done, question, escalation, and the typed stalled / crashed / review_complete / ci_blocker escalations.',
      'Each tick also sweeps runtime liveness, so a stalled or crashed worker becomes a wake event without any model heartbeat.',
      'Acknowledge the returned Delivery with --ack before waiting again.'
    ]
  },
  {
    path: ['orchestration', 'outcome-admit'],
    summary: 'Bind one business outcome to this Run and declare its route candidate order',
    usage:
      'orca orchestration outcome-admit --outcome-id <id> --title <text> [--task-classification <id>] [--builder-candidates <agent[:model[:reasoning]],...>] [--reviewer-candidates <...>] [--review-capabilities <csv>] [--allow-unknown-quota] [--gate-policy <standard|high_risk>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'outcome-id',
      'title',
      'task-classification',
      'builder-candidates',
      'reviewer-candidates',
      'review-capabilities',
      'allow-unknown-quota',
      'gate-policy',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'Admitting an outcome turns on the fail-closed contract for this Run: certified routes at launch, and a SHA-bound completion receipt.',
      'The candidate ORDER is yours; Orca validates each candidate against the certified registry and never invents a preference.',
      'Without a reviewer candidate order, a validated completion emits a protected blocker instead of choosing a reviewer.'
    ]
  },
  {
    path: ['orchestration', 'outcome-intake'],
    summary: 'Atomically admit a 2-5 outcome batch supplied by an upstream planner',
    usage:
      'orca orchestration outcome-intake --batch-id <id> --manifest <path.json> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'batch-id', 'manifest', 'from', 'retry-request'],
    notes: [
      "The manifest carries the outcomes and the SUPPLIER's own overlap claims; Orca binds identity and decides admission, it never classifies the business issue.",
      'All-or-nothing: a batch that fails on any outcome admits none of them, so a retry starts clean.',
      'A detected overlap with no decision is refused, and a decision of reject refuses the whole batch.'
    ]
  },
  {
    path: ['orchestration', 'gates'],
    summary: 'Plan which gates may reuse a receipt and which must rerun',
    usage:
      'orca orchestration gates --sha <sha> --gates <csv> [--files <csv>] [--policy-version <id>] [--record <gate_id> --result <PASS|FAIL>] [--risk-policy <standard|high_risk>] [--outcome <id>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'sha',
      'gates',
      'files',
      'policy-version',
      'record',
      'result',
      'risk-policy',
      'outcome',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'A receipt is reusable only when the final SHA, the changed-file set, the policy version and the command identity all still match.',
      'A high-risk outcome policy reruns the full gate set even when nothing changed.'
    ]
  },
  {
    path: ['orchestration', 'validation-lease'],
    summary: 'Take, release, or check the worktree lease that protects a running suite',
    usage:
      'orca orchestration validation-lease --action <acquire|release|check> [--dispatch <dispatch_id>] [--lease-id <id>] [--idempotency-key <key>] [--ttl-ms <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'action',
      'dispatch',
      'lease-id',
      'idempotency-key',
      'ttl-ms',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'Acquire before running tests or preflight so no worker can mutate the worktree underneath the suite.',
      'While a lease is active, worker-start into that worktree is refused; wait for the lease or use a separate worktree.',
      'A completing Dispatch releases its own lease automatically.'
    ]
  },
  {
    path: ['orchestration', 'phase-launch'],
    summary: 'Show, and by default drive, the automatic reviewer/correction launches',
    usage:
      'orca orchestration phase-launch [--inspect] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'inspect', 'run', 'from', 'retry-request'],
    notes: [
      'Reviewer and correction phases start automatically on the runtime loop; this is the recovery path when one is stuck.',
      'Each launch is keyed by its phase, so driving it repeatedly can never create a second Dispatch or a second worker session.',
      'Use --inspect to read the launch ledger without forcing a pass.'
    ]
  },
  {
    path: ['orchestration', 'route-upsert'],
    summary: 'Register or update one route in the certified role registry',
    usage:
      'orca orchestration route-upsert --agent <agent> [--model <id>] [--reasoning <id>] [--provider <name>] [--harness <name>] [--roles <builder,reviewer>] [--capabilities <csv>] [--session-modes <fresh,retained>] [--cost-class <id>] [--notes <text>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'agent',
      'model',
      'reasoning',
      'provider',
      'harness',
      'roles',
      'capabilities',
      'session-modes',
      'cost-class',
      'notes',
      'retry-request'
    ],
    notes: [
      'Launcher support, agent-hook support, identity proof and reasoning modes are discovered from the authoritative catalogs, not declared.',
      'Registering a route grants eligibility only. Routing still requires certification evidence.'
    ]
  },
  {
    path: ['orchestration', 'certify'],
    summary: 'Record one piece of route certification evidence',
    usage:
      'orca orchestration certify --agent <agent> --role <builder|reviewer> --session-mode <fresh|retained> --kind <evidence_kind> --outcome <PASS|FAIL|UNSUPPORTED> --sha <sha> [--model <id>] [--reasoning <id>] [--dispatch <dispatch_id>] [--detail <text>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'agent',
      'model',
      'reasoning',
      'role',
      'session-mode',
      'kind',
      'outcome',
      'dispatch',
      'sha',
      'detail',
      'retry-request'
    ],
    notes: [
      'PASS requires --dispatch naming a Dispatch that really launched: it must have a recorded process incarnation and a persisted launch receipt whose route matches exactly.',
      'The runtime stamps the observation time and its own version; a caller cannot backdate evidence.',
      'FAIL and UNSUPPORTED need no Dispatch — they only ever restrict routing.'
    ]
  },
  {
    path: ['orchestration', 'routes'],
    summary: 'Show the registry, its drift faults, and the role/session certification matrix',
    usage: 'orca orchestration routes [--sha <sha>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'sha'],
    notes: [
      'Pass --sha to evaluate staleness against the exact commit you are about to run.',
      'The matrix names the outstanding evidence kinds per role and session mode.'
    ]
  }
]
