import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const guidePath = join(projectDir, 'skill-guides', 'orchestration.md')
const referenceRoot = join(projectDir, 'skill-guides', 'orchestration', 'references')
const stubPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

function readKernel() {
  return readFileSync(guidePath, 'utf8')
}

function readReference(name) {
  return readFileSync(join(referenceRoot, name), 'utf8')
}

function frontmatter(text) {
  return /^---\n[\s\S]*?\n---\n/u.exec(text)?.[0]
}

function squash(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

// Routing lives in the frontmatter description alone; the body must not satisfy these.
function readDescription() {
  return squash(frontmatter(readKernel()))
}

describe('orchestration skill routing', () => {
  it('keeps the verbatim routing triggers a model matches the skill on', () => {
    const description = readDescription()

    for (const trigger of [
      'threaded messages',
      'worker_done/escalation waits',
      'decision gates',
      'decomposing work across agents',
      '"hand off"',
      '"handoff"',
      '"handover"',
      '"give this to another agent"',
      '"another worktree"',
      'lightweight terminal prompts',
      'shell commands',
      'Orca worktree management',
      'reading or waiting on terminals'
    ]) {
      expect(description).toContain(trigger)
    }
  })

  it('keeps external browser routing at the OS/page boundary', () => {
    const description = readDescription()

    expect(description).toContain(
      "Use Computer Use for external browser windows, webviews, Orca app UI, or desktop UI outside Orca's embedded browser only when the task requires OS/window-level control such as focus, menus, dialogs, coordinates, or screenshots."
    )
    expect(description).toContain(
      "`orca-cli` for Orca's embedded pages and a page-automation tool such as Playwright or CDP for external pages."
    )
  })
})

describe('orchestration kernel', () => {
  it('keeps the always-loaded guide compact and ordered around the normal protocol', () => {
    const kernel = readKernel()
    const headings = [
      '## Outcome',
      '## Classify the role',
      '## Authority and safety floor',
      '## Worker obligations',
      '## Canonical supervised loop',
      '## Task-spec contract',
      '## Completion accounting',
      '## Conditional references'
    ]

    // Why: 202 is the budget after the anti-loop nextAction rule; the kernel is always in context.
    expect(kernel.split('\n').length).toBeLessThanOrEqual(202)
    for (let index = 1; index < headings.length; index += 1) {
      expect(kernel.indexOf(headings[index])).toBeGreaterThan(kernel.indexOf(headings[index - 1]))
    }
    expect(kernel).not.toContain('## Contract Migration')
    expect(kernel).not.toContain('## Full Handoffs')
    expect(kernel).not.toContain('## Worker Terminals')
  })

  it('classifies coordinator, dispatched worker, handoff, compatibility, and ordinary roles', () => {
    const kernel = readKernel()

    expect(kernel).toContain('explicitly asks to supervise, monitor, wait for results')
    expect(kernel).toContain('live injected preamble with Task and Dispatch IDs')
    expect(kernel).toContain('Handoff owner')
    expect(kernel).toContain('create no Run, Task, or Dispatch and do not monitor completion')
    expect(kernel).toContain('Compatibility operator')
    expect(kernel).toContain('Ordinary terminal agent')
    expect(kernel).toContain('Model or effort selection does not make a handoff supervised')
    expect(squash(kernel)).toContain('Never substitute a non-Orca subagent tool')
  })

  it('makes Dispatch identity, remote uncertainty, folders, and mixed versions a safety floor', () => {
    const kernel = readKernel()

    expect(kernel).toContain('A Dispatch is one authoritative Task attempt')
    expect(kernel).toContain('Lifecycle authority comes from the active Dispatch')
    expect(kernel).toContain('execution host owns')
    expect(squash(kernel)).toContain('`live` / `unverifiable` / `exited`')
    expect(kernel).toContain('contact loss is not process death')
    expect(kernel).toContain('Folder workspaces are valid')
    expect(squash(kernel)).toContain('Treat unknown optional fields as absent')
    expect(kernel).toContain('new stream operation requires advertised capability')
    expect(kernel).toContain('Never fall back to local execution')
  })

  it('puts exactly-once worker completion and post-completion idle before coordinator mechanics', () => {
    const kernel = readKernel()

    expect(kernel.indexOf('## Worker obligations')).toBeLessThan(
      kernel.indexOf('## Canonical supervised loop')
    )
    expect(kernel).toContain('The injected preamble is authoritative')
    expect(kernel).toContain('Send `worker_done` exactly once')
    expect(kernel).toContain('three-sentence executive summary')
    expect(kernel).toContain('`--outcome succeeded` or `--outcome failed`')
    // Why: the runnable worker_done command is the preamble's; its flag spellings are pinned
    // on worker-contract.md by 'keeps heartbeat and worker_done recipes bound to the injected
    // capability', so the kernel carries the obligations as prose and no third copy.
    expect(kernel).not.toContain('--type worker_done')
    expect(kernel).toContain('After `worker_done`, end the dispatched turn and idle')
    expect(kernel).toContain('Do not reuse the settled lifecycle IDs')
  })

  it('teaches worker-start as the only normal-path launch and starts the wave before waiting', () => {
    const kernel = readKernel()
    const firstStart = kernel.indexOf('worker-start --spec "<worker A task>"')
    const secondStart = kernel.indexOf('worker-start --spec "<worker B task>"')
    const firstWait = kernel.indexOf('check --wait')

    expect(firstStart).toBeGreaterThan(kernel.indexOf('run-create'))
    expect(secondStart).toBeGreaterThan(firstStart)
    expect(firstWait).toBeGreaterThan(secondStart)
    expect(squash(kernel)).toContain('start the full independent wave before waiting')
    expect(kernel).toContain('`worker-start` is the normal path')
    expect(squash(kernel)).toContain(
      "If `worker-start` exits non-zero, do not relaunch. Read the receipt's `failedStage` and `residualResources`"
    )
    expect(kernel).toContain('operator-created process unsupervised')
    expect(kernel).not.toMatch(/^ORCA terminal create/mu)
  })

  it('makes worker-start --spec the default and keeps task-create for planned fan-out', () => {
    const kernel = squash(readKernel())

    expect(kernel).toContain('`worker-start --spec` creates the Task and its attempt in one call')
    expect(kernel).toContain('Use `task-create` plus `worker-start --task <task_id>`')
  })

  it('gives the supervised loop an exit condition for a live terminal with a dead agent', () => {
    const kernel = squash(readKernel())

    expect(kernel).toContain("`worker-list`'s `projection.liveness` is the fleet verdict")
    expect(kernel).toContain("`worker-show`'s `observation.status` is PTY liveness only")
    expect(kernel).toContain('After three consecutive empty waits')
    expect(kernel).toContain('`ORCA orchestration worker-list --include-remote --json`')
    expect(kernel).toContain('defaults to the bound Run; `--run <run_id>` overrides')
    expect(kernel).toContain(
      '`projection.attention` categories, `projection.attention.requiresAction`, and literal `projection.nextAction` argv'
    )
    expect(kernel).toContain(
      'An `inspect` `nextAction` on a `live` row with `attention.requiresAction` false is informational, not a command to re-run: keep waiting with `check --wait`'
    )
    expect(kernel).toContain('choose `worker-stop` or `worker-abandon`')
  })

  it('lets only positive evidence of exit end a wait', () => {
    const kernel = squash(readKernel())

    expect(kernel).toContain('Leave the wait only on positive proof the agent stopped')
    expect(kernel).toContain('`exited` liveness')
    expect(kernel).toContain("the worker's own observation of process exit")
    expect(kernel).toContain('transcript whose final agent turn sent no `worker_done`')
    expect(kernel).toContain(
      '`unverifiable` is absence, including when `worker-show` reports `agentWait` null. Absence never authorizes stop, abandon, retry, or release'
    )
  })

  it('names --terminal, never --from, as the check caller flag', () => {
    const kernel = squash(readKernel())

    expect(kernel).toContain('`check` names its caller with `--terminal <handle>`, never `--from`')
    expect(kernel).not.toContain('check --from')
  })

  it('makes a dispatched worker read coordinator follow-ups on a cadence', () => {
    const kernel = squash(readKernel())

    expect(kernel).toContain('Read coordinator follow-ups at each natural checkpoint')
    expect(kernel).toContain('once more immediately before `worker_done`')
    expect(kernel).toContain('`ORCA orchestration check --terminal <your_handle> --json`')
  })

  it('requires full Delivery processing and settled-terminal accounting before ack', () => {
    const kernel = readKernel()

    expect(squash(kernel)).toContain(
      'oldest FIFO Delivery and replays that batch until acknowledged'
    )
    expect(squash(kernel)).toContain('Process every message')
    expect(squash(kernel)).toContain("decide each settled terminal's next owner before the ack")
    expect(squash(kernel)).toContain('reused, explicitly retained, or released')
    expect(squash(kernel)).toContain(
      'the turn ends only when the report to that user names, per Task, its outcome, the evidence behind it, and any unresolved blocker'
    )
    expect(kernel).toContain('worker-release --dispatch <dispatch_id>')
    expect(kernel).toContain('check --ack <delivery_id> --wait')
    expect(squash(kernel)).toContain(
      '`worker-list --run <run_id> --terminal-state reclaimable --json`'
    )
    expect(squash(kernel)).toContain('do not follow it with `task-update --status completed`')
  })

  it('treats long waits and release uncertainty as safe checkpoints', () => {
    const kernel = readKernel()

    // Why: e92d7812d91 and c78f40fdd0b protect one rule; `## Outcome` states it once and each
    // gate cites it, so these pin the condition rather than a per-gate list of non-proofs.
    expect(squash(kernel)).toContain(
      'Only positive proof of exit authorizes stop, abandon, or retry, and only an accepted settlement authorizes release. Every other observation, absence included, is a checkpoint'
    )
    expect(squash(kernel)).toContain('A timeout or empty result is a checkpoint, not a failure')
    expect(squash(kernel)).toContain('Do not stop, retry, release, or launch a duplicate editor')
    expect(squash(kernel)).toContain('without the positive proof `## Outcome` requires')
    expect(squash(kernel)).toContain(
      'Only an accepted settlement authorizes it; no other observation does'
    )
    expect(kernel).toContain('never substitute `terminal close`')
  })

  it('defines self-contained task specs and honest send attention semantics', () => {
    const kernel = readKernel()

    for (const field of [
      '**Target:**',
      '**Change:**',
      '**Constraints:**',
      '**Ownership:**',
      '**Observable acceptance:**'
    ]) {
      expect(kernel).toContain(field)
    }
    expect(kernel).toContain('successful `orchestration send` proves durable enqueue')
    expect(kernel).toContain('best-effort attention only')
    expect(squash(kernel)).toContain('does not prove the recipient read or accepted it')
  })
})

describe('owned orchestration references', () => {
  it('routes every conditional read to exactly one shipped reference', () => {
    const kernel = readKernel()
    const routed = [...kernel.matchAll(/`references\/([^`]+\.md)`/gu)].map((match) => match[1])
    const shipped = readdirSync(referenceRoot)
      .filter((name) => name.endsWith('.md'))
      .sort()

    const tableRoutes = [...kernel.matchAll(/^\|.*`references\/([^`]+\.md)`.*\|$/gmu)].map(
      (match) => match[1]
    )

    expect([...new Set(routed)].sort()).toEqual(shipped)
    // Why the table and not every mention: prose may cite a reference the gate table already routes.
    expect(tableRoutes.sort()).toEqual(shipped)
    expect(kernel).toContain('ORCA skills get orchestration --full')
    // Why: the selector is the cheap path, so the kernel must teach it first and keep
    // `--full` only as the fallback for a CLI build that predates it.
    expect(squash(kernel)).toContain(
      'run `ORCA skills get orchestration --reference references/<file>.md`'
    )
    expect(squash(kernel)).toContain(
      'If the CLI rejects `--reference`, run `ORCA skills get orchestration --full`'
    )
    expect(squash(kernel)).toContain('If an older CLI rejects `--full`')
  })

  it('owns expanded waves, launch preferences, reuse, and review boundaries', () => {
    const reference = readReference('coordinator-loop.md')

    expect(reference).toContain('task-list --ready --brief --json')
    expect(reference).toContain('`--effort` requires `--model`')
    expect(reference).toContain('neither option combines with `--terminal`')
    expect(reference).toContain('`launch.requested` with `launch.effective`')
    expect(reference).toContain('worker-start --task <next_task_id> --terminal')
    expect(reference).toContain('A review-only `worker_done` authorizes synthesis')
    expect(squash(reference)).toContain(
      'post-review fixes and PR preparation remain with that owner'
    )
  })

  it('owns worker heartbeat, ask resume, escalation, failure, and idle', () => {
    const reference = readReference('worker-contract.md')

    expect(reference).toContain('--type heartbeat')
    expect(reference).toContain('--task-id <task_id> --dispatch-id <dispatch_id>')
    expect(reference).toContain('--phase "<investigating|implementing|reviewing|waiting>"')
    expect(reference).toContain('--resume <message_id>')
    expect(reference).toContain('do not create a duplicate question')
    expect(reference).toContain('--type escalation')
    expect(reference).toContain('Send exactly one terminal report')
    expect(reference).toContain('Use `--outcome failed`')
    expect(reference).toContain('After `worker_done`, end the dispatched turn and idle')
    expect(squash(reference)).toContain(
      'ORCA orchestration check --terminal <worker_handle> --json'
    )
    expect(squash(reference)).toContain('once more immediately before `worker_done`')
    expect(squash(reference)).toContain(
      '`check` names its caller with `--terminal`, never `--from`'
    )
    expect(squash(reference)).toContain('If `check` returns `consumer_fenced`')
    expect(squash(reference)).toContain('An empty `check` never means you were replaced')
  })

  it('keeps heartbeat and worker_done recipes bound to the injected capability', () => {
    const reference = readReference('worker-contract.md')
    const recipes = [...reference.matchAll(/```text\n([\s\S]*?)```/gu)].map((match) => match[1])
    const heartbeat = recipes.find((recipe) => recipe.includes('--type heartbeat'))
    const workerDone = recipes.find((recipe) => recipe.includes('--type worker_done'))

    for (const recipe of [heartbeat, workerDone]) {
      expect(recipe).toContain('--from <worker_handle>')
      expect(recipe).toContain('--dispatch-capability <capability>')
      expect(recipe).toContain('--task-id <task_id> --dispatch-id <dispatch_id>')
    }
    expect(workerDone).not.toContain('--files-modified')
    expect(workerDone).not.toContain('--report-path')
    expect(squash(reference)).toContain('only when applicable, using actual paths')
    expect(reference).toContain('Do not send documentation placeholders as metadata')
  })

  it('owns local, folder, worktree, SSH, WSL, remote, and mixed-version placement', () => {
    const reference = readReference('placement-and-remote.md')

    expect(reference).toContain('--worktree current --agent codex')
    expect(squash(reference)).toContain(
      'A worktree selector needs the full `<repo-id>::<path>` value Orca returned, passed as `id:<newFullWorktreeId>`; a bare repo id is not a worktree id'
    )
    expect(reference).toContain('--worktree new-child')
    expect(reference).toContain('--worktree new-top-level')
    expect(reference).toContain('Folder workspaces are first-class')
    expect(reference).toContain('Remote `current` and `new-child` are invalid')
    expect(squash(reference)).toContain("`--on` selects only the worker's execution server")
    expect(squash(reference)).toContain(
      'route every follow-up, read, stop, and cleanup by Dispatch ID'
    )
    expect(reference).toContain('`live`, `unverifiable`, or `exited`')
    expect(squash(reference)).toContain('unknown stream opcodes can be silently dropped')
    expect(reference).toContain('printed `orca-ide`')
    expect(squash(reference)).toContain(
      'ORCA project setup-existing-folder --project <project_id> --host <host_id> --path <abs_path> --kind folder --json'
    )
    expect(squash(reference)).toContain('and rejects a plain directory')
    expect(reference).toContain(
      'ORCA orchestration worker-list --run <run_id> --include-remote --json'
    )
    expect(squash(reference)).toContain(
      'enumerate remote workers with `--include-remote` or every one of them reads `unverifiable`'
    )
  })

  it('owns FIFO mail, Dispatch addresses, groups, questions, and gates', () => {
    const reference = readReference('messaging-and-gates.md')

    expect(reference).toContain('oldest FIFO Delivery')
    expect(squash(reference)).toContain('Process every row')
    expect(squash(reference)).toContain(
      'A Delivery therefore always carries the whole FIFO batch whatever its types, and a `check` without `--wait` hands that batch over unfiltered'
    )
    expect(reference).toContain('send --to dispatch:<dispatch_id>')
    for (const group of ['@all', '@grok', '@cursor', '@worktree:<id>']) {
      expect(reference).toContain(group)
    }
    expect(reference).toContain('Dispatch lifecycle messages never target groups')
    expect(reference).toContain('gate-create --task <task_id>')
    expect(reference).toContain("Do not create a gate merely to answer a worker's `ask`")
    expect(reference).toContain('successful `send` proves durable enqueue')
    expect(squash(reference)).toContain('Wake and nudge are best-effort attention only')
    expect(squash(reference)).toContain(
      '`check` names its caller with `--terminal <handle>` and is the only verb that rejects `--from`'
    )
  })

  it('owns positive-evidence retry, unknown outcomes, retain/release, and no terminal close', () => {
    const reference = readReference('recovery-and-cleanup.md')

    expect(squash(reference)).toContain('| `ready` or active | Keep waiting')
    expect(squash(reference)).toContain('| `outcome_unknown` | Inspect')
    expect(squash(reference)).toContain('| Remote contact lost | Preserve `unverifiable`')
    expect(reference).toContain('--retry-of <dispatch_id>')
    expect(squash(reference)).toContain('Placement is never silently inherited')
    expect(reference).toContain('worker-abandon --dispatch')
    expect(reference).toContain('worker-retain --dispatch')
    expect(reference).toContain('worker-release --dispatch')
    expect(squash(reference)).toContain('`release_pending` or `release_unknown`')
    expect(squash(reference)).toContain('Never substitute `terminal close`')
  })

  it('owns the lost-response question and the request-show verdicts', () => {
    const reference = squash(readReference('recovery-and-cleanup.md'))

    expect(reference).toContain('request-show --request <request_id> --json')
    expect(reference).toContain('--retry-request <request_id>')
    expect(reference).toContain('`completed` means the mutation already took effect')
    expect(reference).toContain('`pending` means the original mutation is still running')
    expect(reference).toContain('that is not proof nothing happened')
    expect(reference).toContain('terminal send --wait-submit <seconds>')
  })

  it('names worker-list as the enumerating command and the agent-liveness authority', () => {
    const reference = squash(readReference('recovery-and-cleanup.md'))

    expect(reference).toContain('ORCA orchestration worker-list --run <run_id> --json')
    expect(reference).toContain("`worker-show`'s `observation.status` is PTY liveness only")
    expect(reference).toContain(
      '`projection.attention.categories`, `projection.attention.requiresAction`'
    )
    expect(reference).toContain('`projection.nextAction` argv')
    expect(reference).toContain('the fleet verdict decides')
    expect(reference).toContain(
      'ORCA orchestration worker-list --run <run_id> --include-remote --json'
    )
    expect(reference).toContain('reads `unverifiable` until you enumerate with `--include-remote`')
    expect(reference).toContain('follow `page.nextCursor` with `--cursor <value>`')
  })

  it('requires positive evidence of exit before stop, abandon, retry, or release', () => {
    const reference = squash(readReference('recovery-and-cleanup.md'))

    expect(reference).toContain('Leave the wait only on positive proof the agent stopped')
    expect(reference).toContain('`unverifiable` is always absence')
    expect(reference).toContain('Absence never authorizes stop, abandon, retry, or release')
    expect(reference).toContain(
      '| `unverifiable` liveness | Keep waiting or inspect; never stop, abandon, retry, or release |'
    )
  })

  it('owns the custom topology exception without claiming process ownership', () => {
    const reference = readReference('low-level-topology.md')

    expect(reference).toContain('only when `worker-start` cannot express')
    expect(reference).toContain('terminal create --worktree active')
    expect(reference).toContain('dispatch --task <task_id> --to <handle> --inject')
    expect(reference).toContain('operator-created process unsupervised')
    expect(squash(reference)).toContain('creates no supervised worker resource row')
    expect(reference).toContain('Use `worker-start --terminal <handle>`')
    expect(squash(reference)).toContain('never use it for an ownership handoff')
  })

  it('owns legacy labels, read-only degradation, exact recovery, and takeover', () => {
    const reference = readReference('legacy-contract-migration.md')

    expect(reference).toContain('[LEGACY COMPATIBILITY]')
    expect(reference).toContain('[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]')
    expect(reference).toContain('[LEGACY READ-ONLY]')
    expect(squash(reference)).toContain(
      'degrade to read-only inspection and never fall back to local execution'
    )
    expect(squash(reference)).toContain(
      'must not spawn, write, signal, stop, switch, focus, split, or inject'
    )
    expect(reference).toContain('launcher status `75`')
    expect(reference).toContain('run_legacy_local')
    expect(reference).toContain('Recovered orchestration work from a contract update')
    expect(reference).toContain('run-use --id <adopted_run_id> --takeover-legacy')
    expect(reference).toContain(
      'Never take over while the original coordinator is actively coordinating'
    )
  })
})

describe('orchestration install stub', () => {
  it('preserves the safe version-matched resolver and bounded old-binary fallback', () => {
    const stub = readFileSync(stubPath, 'utf8')

    expect(stub).toContain('discovery stub')
    expect(stub).toContain('ORCA skills get orchestration')
    expect(stub).toContain('ORCA_CLI_COMMAND')
    expect(stub).toContain('orca-dev')
    expect(stub).toContain('orca-ide')
    expect(stub).toContain('GNOME Orca screen reader')
    expect(squash(stub)).toContain('explicitly reports that `skills get` is an unknown command')
    expect(stub).toContain('do not invent commands')
    expect(stub).not.toMatch(/^orca /mu)
  })

  it('performs no orchestration mutation before loading the guide', () => {
    const stub = readFileSync(stubPath, 'utf8')
    const preGuide = stub.split('## Load the full guide')[0]

    expect(preGuide).not.toContain('orchestration task-create')
    expect(preGuide).not.toContain('orchestration dispatch')
    expect(frontmatter(stub)).toBe(frontmatter(readKernel()))
    expect(stub.length).toBeLessThan(readKernel().length)
  })
})
