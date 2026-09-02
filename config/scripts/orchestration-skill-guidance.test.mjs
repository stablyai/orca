import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: orchestration now ships a hybrid discovery stub, so its version-sensitive command
// guidance lives in the authoritative guide source — assert that content there. The
// installable stub projection is checked separately below.
const guidePath = join(projectDir, 'skill-guides', 'orchestration.md')
const stubPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

function readSkill() {
  return readFileSync(guidePath, 'utf8')
}

function getSection(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(
    new RegExp(`## ${escapedHeading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`)
  )

  expect(match).not.toBeNull()

  return match?.[1] ?? ''
}

describe('orchestration skill guidance', () => {
  it('keeps external browser routing at the OS/page boundary', () => {
    const description = readFileSync(guidePath, 'utf8').replace(/\s+/gu, ' ')

    expect(description).toContain(
      "Use Computer Use for external browser windows, webviews, Orca app UI, or desktop UI outside Orca's embedded browser only when the task requires OS/window-level control such as focus, menus, dialogs, coordinates, or screenshots."
    )
    expect(description).toContain(
      "`orca-cli` for Orca's embedded pages and a page-automation tool such as Playwright or CDP for external pages."
    )
  })

  it('requires Orca runtime state before claiming a worker was orchestrated', () => {
    const skill = readSkill()
    const toolBoundary = getSection(skill, 'Tool Boundary')

    expect(toolBoundary).toContain('must create or bind a Run')
    expect(toolBoundary).toContain('create the Task with `orca orchestration task-create`')
    expect(toolBoundary).toContain('preferred `orca orchestration worker-start` composition')
    expect(toolBoundary).toContain('low-level `orca orchestration dispatch --inject` path')
    expect(toolBoundary).not.toContain('or `orca orchestration run`')
    expect(skill).toContain(
      '`coordinator-start`, `coordinator-stop`, `run`, and `run-stop` are retired scheduler commands'
    )
    expect(toolBoundary).toContain(
      'Do not substitute non-Orca subagent tools, generic agent-spawn APIs, or chat-only parallel worker features'
    )
    expect(toolBoundary).toContain('do not create Orca task/dispatch provenance')
    expect(toolBoundary).toContain('injected lifecycle preambles')
    expect(toolBoundary).toContain('`worker_done` authority')
    expect(toolBoundary).toContain('decision gates')
    expect(toolBoundary).toContain('orca orchestration task-list --json')
    expect(toolBoundary).toContain('orca orchestration dispatch-show --task <task_id> --json')
    expect(toolBoundary).toContain(
      'do not retroactively describe the external worker as orchestrated'
    )
  })

  it('teaches attested adoption without reviving the retired scheduler', () => {
    const skill = readSkill()
    const migration = getSection(skill, 'Contract Migration')

    expect(migration).toContain(
      'adopts a live pre-update orchestration assignment into an ordinary Run'
    )
    expect(migration).toContain(
      'preserves the existing agent process, PTY/session, terminal handle, tab/leaf/pane, worktree or folder workspace, Task, and Dispatch'
    )
    expect(migration).toContain('never restarts or replaces the worker')
    expect(migration).toContain('The retired scheduler is not revived')
    expect(migration).toContain('[LEGACY COMPATIBILITY]')
    expect(migration).toContain('[LEGACY READ-ONLY]')
    expect(migration).toContain(
      'Loss of lifecycle authority does not invalidate the existing assignment, process, or filesystem work.'
    )
    expect(migration).toContain(
      'It must not spawn, write, signal, stop, switch, focus, split, or inject a terminal.'
    )
    expect(migration).not.toContain('task-list --run run_legacy_local')
    expect(migration).toContain('run_legacy_local is an empty audit tombstone')
    expect(migration).toContain('Recovered orchestration work from a contract update')
    expect(migration).toContain('run-show --id <adopted_run_id>')
    expect(migration).toContain('task-list --run <adopted_run_id>')
    expect(migration).toContain('Legacy inspection remains available without consuming mail')
    expect(migration).toContain('run-use --id <adopted_run_id> --takeover-legacy')
    expect(migration).toContain('Takeover fences only the old coordinator')
    expect(migration).toContain('Live legacy workers keep their original Tasks, Dispatches')
    expect(migration).toContain(
      'keep the original worker as the only editor until it reaches a stable handoff point'
    )
    expect(migration).toContain('a conflict-free placement for any remaining work')
  })

  it('treats long-running worker waits as liveness checkpoints, not failures', () => {
    const skill = readSkill()

    expect(skill).toContain('Treat a `check --wait` timeout or `{count:0}` as a checkpoint')
    expect(skill).toContain('Do not stop, close, kill, or restart a worker')
    expect(skill).toContain('keep waiting instead of retrying the task')
    expect(skill).not.toContain(
      'If `check --wait` times out with no `worker_done` or `escalation`, fall back to `terminal wait --for tui-idle`, then `terminal read`.'
    )
  })

  it('keeps full handoffs out of dispatch lifecycle and off the active branch base', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    expect(skill).toContain('Full handoff means ownership transfer, not supervised dispatch.')
    expect(fullHandoffs).toContain(
      'Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs.'
    )
    expect(fullHandoffs).toContain(
      '`task-create` is also forbidden because it records coordinator-owned tracking state'
    )
    expect(fullHandoffs).toContain('Do not create a `taskId`/`dispatchId`')
    expect(fullHandoffs).toContain(
      'read the worker terminal after prompt delivery except to avoid losing the initial prompt'
    )
    expect(skill).toContain(
      '`--no-parent` only controls Orca lineage; it does not choose the Git base.'
    )
    expect(skill).toContain(
      'never base it on the current feature branch unless the user explicitly asks'
    )
    expect(skill).toContain(
      'orca worktree create --name <task-name> --no-parent --agent codex --prompt'
    )
    expect(fullHandoffs).toContain(
      'Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level'
    )
    expect(fullHandoffs).toContain(
      'Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree'
    )
    expect(fullHandoffs).toContain(
      'For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`'
    )
    expect(fullHandoffs).toContain('If the work should start from the repo default base')
    expect(fullHandoffs).toContain('omit `--base-branch`')
  })

  it('classifies handoff wording as ownership transfer unless supervision is explicit', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    for (const phrase of [
      'hand off',
      'handoff',
      'handover',
      'give this to another agent',
      'give this to another worktree',
      'another agent',
      'another worktree'
    ]) {
      expect(fullHandoffs).toContain(phrase)
    }

    for (const supervisionPhrase of [
      'supervise',
      'monitor',
      'wait for worker_done',
      'wait for results',
      'track completion',
      'DAG',
      'decision gate',
      'ask/reply'
    ]) {
      expect(fullHandoffs).toContain(supervisionPhrase)
    }
  })

  it('documents custom model and effort handoffs without completion monitoring', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    expect(fullHandoffs).toContain('Custom Codex model/effort handoff')
    expect(fullHandoffs).toContain(
      'does not accept Codex-specific `--model` or `-c model_reasoning_effort=...` arguments'
    )
    expect(fullHandoffs).toContain('codex --model gpt-5.5 -c model_reasoning_effort="xhigh"')
    expect(fullHandoffs).toContain(
      'Wait only for `tui-idle` when needed to avoid losing the prompt.'
    )
    expect(fullHandoffs).toContain('Do not monitor task completion.')
  })

  it('clarifies sidebar lineage for same-worktree orchestrated workers', () => {
    const skill = readSkill()
    const workerTerminals = getSection(skill, 'Worker Terminals')

    expect(workerTerminals).toContain(
      'Sidebar lineage and orchestration lifecycle are related but not identical.'
    )
    expect(workerTerminals).toContain(
      'A same-worktree worker may appear as a peer under that worktree in the sidebar'
    )
    expect(workerTerminals).toContain('while remaining a child dispatch in orchestration state')
    expect(workerTerminals).toContain(
      'only an actual child worktree creates visible parent/child worktree lineage'
    )
    expect(workerTerminals).toContain(
      'Create a new worktree only when the user explicitly requests one or a concrete checkout or filesystem conflict makes sharing unsafe or impossible'
    )
    expect(workerTerminals).toContain(
      'Independent tasks, parallel execution, convenience, or a preference for separate checkouts are not isolation requirements.'
    )
    expect(workerTerminals).toContain(
      'When a new worktree is allowed, use child lineage for isolated work that is stacked under or dependent on the active worktree'
    )
    expect(workerTerminals).toContain('use `--no-parent` when it is not stacked')
  })

  it('keeps review-only completions and named next-owner fixes in their lanes', () => {
    const skill = readSkill()

    expect(skill).toContain(
      'A review-only `worker_done` reports findings; it does not authorize coordinator file edits.'
    )
    expect(skill).toContain('unless the user explicitly asked the coordinator to own fixes')
    expect(skill).toContain('dispatch or hand off fixes')
    expect(skill).toContain(
      "If the user's plan names a next owner agent " +
        '(for example, "then use opencode to create a PR")'
    )
    expect(skill).toContain('post-review corrections and PR prep belong to that named owner')
    expect(skill).toContain('the named owner edits files and creates the PR')
  })

  it('keeps post-completion workers idle without subordinating the user', () => {
    const skill = readSkill()
    const agentGuidance = getSection(skill, 'Agent Guidance')

    expect(agentGuidance).toContain('After sending `worker_done`, end that dispatched turn')
    expect(agentGuidance).toContain('idle at the agent prompt')
    expect(agentGuidance).toContain('Do not autonomously start more work, poll')
    expect(agentGuidance).toContain('A direct user instruction takes precedence')
    expect(agentGuidance).toContain('follow it without coordinator approval or a fresh Dispatch')
    expect(agentGuidance).toContain('never refuse it because of worker/coordinator roles')
    expect(agentGuidance).toContain("do not reuse the settled Dispatch's lifecycle IDs")
    expect(agentGuidance).toContain(
      'A coordinator-supervised follow-up still arrives with a fresh preamble + TASK block'
    )
    expect(skill).not.toContain('post-completion polling messages')
    expect(skill).not.toContain('every 2 minutes')
  })

  it('makes settled worker terminal release an explicit coordinator step', () => {
    const skill = readSkill()
    const workerLoop = getSection(skill, 'Preferred Supervised Worker Loop')
    const agentGuidance = getSection(skill, 'Agent Guidance')
    const nextAction = getSection(skill, 'Next Action')

    expect(workerLoop).toContain(
      '# Process every message. For each accepted worker_done that is not immediately reused:\n' +
        'orca orchestration worker-release --dispatch <dispatch_id> --json'
    )
    expect(workerLoop).toContain(
      'Acknowledge only after every message and required release decision is handled'
    )
    expect(workerLoop).toContain(
      'read the `worker.agent_terminal_handle` field of `worker-show --dispatch <dispatch_id> --json`'
    )
    expect(workerLoop).toContain(
      'orca orchestration worker-start --task <next_task_id> --terminal <handle> --json` so Orca ' +
        'transfers cleanup ownership to the new Dispatch'
    )
    expect(workerLoop).toContain(
      'Run `worker-release` after both succeeded and failed `worker_done` reports unless the user ' +
        'explicitly asked to keep that worker live.'
    )
    expect(workerLoop).toContain('Release is post-completion cleanup, not cancellation')
    expect(workerLoop).toContain('orca orchestration worker-retain --dispatch <dispatch_id> --json')
    expect(workerLoop).toContain(
      'the same Dispatch can be passed to `worker-release`, which clears the requested retention'
    )
    expect(agentGuidance).toContain(
      'Coordinators must account for every settled worker terminal before waiting again or ending ' +
        'the turn'
    )
    expect(agentGuidance).toContain('released workers remain readable through `worker-read`')
    expect(nextAction).toContain(
      'After every accepted `worker_done`, either transfer the exact terminal to an immediate ' +
        'follow-up Dispatch or run `worker-release` before the next wait.'
    )
  })

  it('documents per-invocation model and effort for supervised workers', () => {
    const workerLoop = getSection(readSkill(), 'Preferred Supervised Worker Loop')

    expect(workerLoop).toContain('opaque provider model id with `--model`')
    expect(workerLoop).toContain('`--effort` requires `--model`')
    expect(workerLoop).toContain('neither option can combine with `--terminal`')
    expect(workerLoop).toContain('--agent claude --model opus --effort high --json')
    expect(workerLoop).toContain('`launch.requested` and `launch.effective`')
  })

  it('never authorizes release from idle, timeout, or worker-side triggers', () => {
    const skill = readSkill()
    const workerLoop = getSection(skill, 'Preferred Supervised Worker Loop')
    const agentGuidance = getSection(skill, 'Agent Guidance')

    // The prohibition sentence is the guard the negative patterns below rely on.
    expect(workerLoop).toContain(
      'Do not release a worker because of a timeout, TUI idle state, heartbeat, status, question, ' +
        'escalation, or rejected/stale `worker_done`.'
    )
    expect(workerLoop).toContain(
      'do not substitute `terminal close`; follow the exact recovery action in the receipt'
    )
    expect(skill).not.toMatch(
      /release[^.]*\bon (?:a |the )?(?:tui-?idle|idle|timeout|heartbeat|question|escalation)\b/iu
    )
    expect(skill).not.toMatch(
      /\b(?:after|on|upon) (?:a |the )?(?:tui-?idle|idle state|timeout|heartbeat)\b[^.]*\brelease/iu
    )
    expect(agentGuidance).toContain(
      'Do not autonomously start more work, poll, or attempt to close the terminal yourself'
    )
    expect(agentGuidance).not.toMatch(/worker-release[^.]*\byourself\b/iu)
  })

  it('documents @grok in the Messaging group address list', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')

    expect(messaging).toContain('`@grok`')
  })

  it('documents @cursor in the Messaging group address list', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')

    expect(messaging).toContain('`@cursor`')
  })

  it('keeps agent-first launch, handle recovery, and inbox injection distinct', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')
    const workerTerminals = getSection(skill, 'Worker Terminals')
    const agentFirstExample = workerTerminals.match(
      /```bash\norca worktree create --name <task-name> --agent codex --setup run --json\n[\s\S]*?```/
    )?.[0]

    expect(workerTerminals).toContain('For an allowed new worktree, use agent-first:')
    expect(workerTerminals).toContain('fallback shell + agent pair')
    expect(workerTerminals).toContain(
      'repo setup and default-terminal settings may add intentional tabs or splits'
    )
    expect(workerTerminals).toContain('without configured default tabs')
    expect(workerTerminals).toContain(
      'only after `terminal list` or `terminal show` confirms it is an unused shell'
    )
    expect(workerTerminals).not.toContain('bare create opens a default shell')
    expect(workerTerminals).not.toContain('ends with **one** agent tab')
    expect(agentFirstExample).toBeDefined()
    expect(agentFirstExample).not.toContain('orca terminal list')
    expect(agentFirstExample).toContain('agentTerminalHandle')
    expect(agentFirstExample).toContain('startupTerminal.handle')
    expect(messaging).toContain('Prefer `agentTerminalHandle` from the create response')
    expect(messaging).toContain('Continue with the replacement handle only')
    expect(messaging).toContain('never writes to terminal input or remotely wakes another terminal')
    expect(messaging).toContain('Use `orchestration dispatch --inject` to deliver a tracked task')
  })
})

describe('orchestration install stub', () => {
  it('points at the version-matched guide and preserves the safe resolver', () => {
    const stub = readFileSync(stubPath, 'utf8')

    expect(stub).toContain('discovery stub')
    expect(stub).toContain('ORCA skills get orchestration')
    // The safe CLI-resolution contract must survive in the stub, never a bare `orca`.
    expect(stub).toContain('ORCA_CLI_COMMAND')
    expect(stub).toContain('orca-dev')
    expect(stub).toContain('orca-ide')
    expect(stub).toContain('GNOME Orca screen reader')
    expect(stub).not.toMatch(/^orca /mu)
  })

  it('does not tell agents to mutate orchestration state before loading the guide', () => {
    const preGuide = readFileSync(stubPath, 'utf8').split('## Load the full guide')[0]

    expect(preGuide).not.toContain('orca orchestration task-create')
    expect(preGuide).not.toContain('orca orchestration dispatch')
  })

  it('gives older binaries a bounded fallback instead of a dead end', () => {
    const stub = readFileSync(stubPath, 'utf8').replace(/\s+/gu, ' ')

    expect(stub).toContain('explicitly reports that `skills get` is an unknown command')
    expect(stub).toContain('do not invent commands')
    expect(stub).toContain('ask the user rather than guessing')
  })

  it('drops the changing command reference from the installable file', () => {
    const stub = readFileSync(stubPath, 'utf8')

    // Version-sensitive command detail lives in the binary-served guide now, not here.
    expect(stub).not.toContain('check --wait')
    expect(stub).not.toContain('dispatch-show')
    expect(stub.length).toBeLessThan(readFileSync(guidePath, 'utf8').length)
  })

  it('keeps the routing frontmatter identical to the guide', () => {
    const frontmatter = (text) => /^---\n[\s\S]*?\n---\n/u.exec(text)[0]

    expect(frontmatter(readFileSync(stubPath, 'utf8'))).toBe(
      frontmatter(readFileSync(guidePath, 'utf8'))
    )
  })
})
