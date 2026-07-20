import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const skillPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

function readSkill() {
  return readFileSync(skillPath, 'utf8')
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
  it('requires Orca runtime state before claiming a worker was orchestrated', () => {
    const skill = readSkill()
    const toolBoundary = getSection(skill, 'Tool Boundary')

    expect(toolBoundary).toContain(
      'must create Orca runtime state with `orca orchestration task-create` and `orca orchestration dispatch --inject`'
    )
    expect(toolBoundary).toContain('or `orca orchestration run`')
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

  it('keeps worker_done post-completion guidance idle instead of polling', () => {
    const skill = readSkill()
    const agentGuidance = getSection(skill, 'Agent Guidance')

    expect(agentGuidance).toContain('After sending `worker_done`, end your turn')
    expect(agentGuidance).toContain('idle at the agent prompt')
    expect(agentGuidance).toContain('Do not poll or keep calling `orca orchestration check`')
    expect(agentGuidance).toContain('fresh preamble + TASK block delivered as new terminal input')
    expect(skill).not.toContain('post-completion polling messages')
    expect(skill).not.toContain('every 2 minutes')
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
      /```bash\norca worktree create --name <task-name> --agent codex --json\n[\s\S]*?```/
    )?.[0]

    expect(workerTerminals).toContain('For an allowed new worktree, use agent-first:')
    expect(workerTerminals).toContain('fallback shell + agent pair')
    expect(workerTerminals).toContain(
      'Repo setup or default-terminal settings may still add tabs or splits'
    )
    expect(workerTerminals).toContain('without configured default tabs')
    expect(workerTerminals).toContain(
      'only after `terminal list` or `terminal show` confirms it is an unused shell'
    )
    expect(workerTerminals).not.toContain('bare create opens a default shell')
    expect(workerTerminals).not.toContain('ends with **one** agent tab')
    expect(agentFirstExample).toBeDefined()
    expect(agentFirstExample).not.toContain('orca terminal list')
    expect(agentFirstExample).toContain('startupTerminal.handle')
    expect(messaging).toContain(
      'Use `startupTerminal.handle` from the create response when present'
    )
    expect(messaging).toContain('continue with the replacement only')
    expect(messaging).toContain('it does not remotely wake another terminal')
    expect(messaging).toContain('Use `orchestration dispatch --inject` to deliver a tracked task')
  })
})
