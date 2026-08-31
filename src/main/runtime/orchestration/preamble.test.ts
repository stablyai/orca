import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './preamble'

function baseParams(overrides: Partial<Parameters<typeof buildDispatchPreamble>[0]> = {}) {
  return {
    taskId: 'task_abc123',
    dispatchId: 'ctx_def456',
    taskSpec: 'Implement the login form',
    coordinatorHandle: 'term_coord',
    workerHandle: 'term_worker',
    ...overrides
  }
}

function afterWorkerDoneSection(result: string) {
  const sectionStart = result.indexOf('=== AFTER YOU SEND worker_done ===')
  const sectionEnd = result.indexOf('=== TASK ===')

  expect(sectionStart).toBeGreaterThan(-1)
  expect(sectionEnd).toBeGreaterThan(sectionStart)

  return result.slice(sectionStart, sectionEnd)
}

describe('buildDispatchPreamble', () => {
  it('substitutes template variables', () => {
    const result = buildDispatchPreamble(baseParams())

    expect(result).toContain('task_abc123')
    expect(result).toContain('ctx_def456')
    expect(result).toContain('term_coord')
    expect(result).toContain('Implement the login form')
    expect(result).not.toContain('{{')
  })

  it('includes worker_done command with --body 3-sentence summary prompt and reportPath', () => {
    const result = buildDispatchPreamble(baseParams())

    expect(result).toContain('worker_done')
    expect(result).toContain('orchestration send')
    expect(result).toContain('orchestration check')
    expect(result).toContain('--body')
    expect(result).toMatch(/3-sentence summary/)
    expect(result).toContain('reportPath')
    expect(result).toContain('--task-id task_abc123')
    expect(result).toContain('--dispatch-id ctx_def456')
    expect(result).toContain('--outcome succeeded')
    expect(result).toContain('replace it with --outcome failed')
    expect(result).toContain('--files-modified "path/a,path/b"')
    expect(result).toContain('--report-path "<optional: path to the full artifact>"')
    expect(result).toMatch(/orchestration send --from term_worker/)
    expect(result).not.toContain('orchestration send --to term_coord')
  })

  it(
    'CLI examples parse as valid shell (bash -n on the extracted block)',
    { timeout: 15_000 },
    () => {
      const result = buildDispatchPreamble(baseParams())
      // Why: feeding `bash -n` the full preamble falsely fails on apostrophes
      // in the surrounding prose. Slice between the CLI markers and strip
      // shell-style comment lines so we only syntax-check the commands.
      const cliStart = result.indexOf('=== CLI COMMANDS ===')
      const cliEnd = result.indexOf('=== AFTER YOU SEND worker_done ===')
      expect(cliStart).toBeGreaterThan(-1)
      expect(cliEnd).toBeGreaterThan(cliStart)
      const block = result.slice(cliStart, cliEnd)
      const stripped = block
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => !line.trim().startsWith('==='))
        .join('\n')

      const check = spawnSync('bash', ['-n'], { input: stripped, encoding: 'utf8' })
      expect(check.status).toBe(0)
    }
  )

  it('includes heartbeat CLI block with taskId and dispatchId and 5-minute cadence', () => {
    const result = buildDispatchPreamble(baseParams())
    expect(result).toContain('--type heartbeat')
    expect(result).toContain('--subject "alive"')
    expect(result).toMatch(/5 minutes/)
    // Both taskId and dispatchId are rendered as structured payload flags
    // (regression guard for §5.3.4 attribution — dispatchId attribution
    // prevents the zombie-heartbeat-masks-hung-retry race).
    expect(result).toContain('--task-id task_abc123')
    expect(result).toContain('--dispatch-id ctx_def456')
    expect(result).toContain('--phase "<short: investigating|implementing|reviewing|waiting>"')
    expect(result).toMatch(/orchestration send --from term_worker/)
  })

  it('includes ask block with BEHAVIOR RULE #1 forbidding AskUserQuestion', () => {
    const result = buildDispatchPreamble(baseParams())
    expect(result).toMatch(/orchestration ask --from term_worker/)
    expect(result).toContain('--question')
    expect(result).toContain('--timeout-ms 600000')
    expect(result).not.toContain('--type decision_gate')
    // Why: the exact phrase is asserted so the rule can't be trimmed away by
    // accident. BEHAVIOR RULE #1 is the only place AskUserQuestion appears.
    expect(result).toContain('BEHAVIOR RULE #1')
    expect(result).toContain('NEVER use AskUserQuestion')
    // AskUserQuestion must appear ONLY inside the rule text, not anywhere
    // else (e.g., not in an example payload or header). Count occurrences
    // of the exact token as a sanity check.
    const occurrences = (result.match(/AskUserQuestion/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  it('binds every injected worker command to the dispatched terminal', () => {
    const result = buildDispatchPreamble(baseParams())

    expect(result).toMatch(/orchestration ask --from term_worker/)
    expect(result).toMatch(/orchestration send --from term_worker \\\n    --type escalation/)
    expect(result).toContain('--task-id task_abc123 --dispatch-id ctx_def456')
    expect(result).toContain('orchestration check --terminal term_worker')
  })

  it('carries the minted Dispatch capability on lifecycle and question commands', () => {
    const result = buildDispatchPreamble({
      ...baseParams(),
      dispatchCapability: 'dcap_test_secret'
    })

    expect(result.match(/--dispatch-capability dcap_test_secret/g)).toHaveLength(4)
    expect(result).not.toContain('"dispatchCapability"')
  })

  it('idles prompt-returning workers while preserving direct user authority', () => {
    const result = buildDispatchPreamble(baseParams())
    const section = afterWorkerDoneSection(result)

    expect(section).toContain('=== AFTER YOU SEND worker_done ===')
    expect(section).toContain('worker_done ends your turn for this task')
    expect(section).toContain('return to an idle prompt')
    expect(section).toContain('Do not exit the shell')
    expect(section).toContain('do NOT run a sleep/poll loop')
    expect(section).toContain('do NOT keep calling')
    expect(section).toContain('A direct instruction from the user takes precedence')
    expect(section).toMatch(/follow it without coordinator approval or a\s+fresh Dispatch/)
    expect(section).toMatch(
      /do not send lifecycle messages using the settled task or\s+Dispatch IDs/
    )
    expect(section).toContain('Never refuse a direct user request because you were a worker')
    expect(section).toMatch(/fresh\s+preamble \+ TASK block/)
    expect(section).not.toMatch(/2 minutes/)
    expect(section).not.toMatch(/10 minutes/)
    expect(section).not.toMatch(/may exit/)
    expect(section).not.toMatch(/grace period/)
  })

  it('tells bare-shell workers to exit after worker_done', () => {
    const result = buildDispatchPreamble(baseParams({ workerKind: 'bare-shell' }))
    const section = afterWorkerDoneSection(result)

    expect(section).toContain('Exit the shell after completion')
    expect(section).toContain('Bare-shell workers have no idle agent')
    expect(section).toContain('do NOT run a sleep/poll loop')
    expect(section).not.toContain('Do not exit the shell')
    expect(section).not.toMatch(/2 minutes/)
    expect(section).not.toMatch(/may exit/)
  })

  it('uses === TASK === separator with the task spec appended', () => {
    const result = buildDispatchPreamble(baseParams({ taskSpec: 'refactor the auth module' }))
    expect(result).toContain('=== TASK ===')
    expect(result).toContain('refactor the auth module')
  })

  it('uses only the bound file adapter for an isolated container worker', () => {
    const result = buildDispatchPreamble(
      baseParams({
        lifecycleAdapter: 'container-file',
        dispatchCapability: 'dcap_must_not_cross_boundary',
        canDispatchSubWorkers: true
      })
    )

    expect(result).toContain('orca-worker-report --type worker_done --outcome succeeded')
    expect(result).toContain('orca-worker-report --type escalation')
    expect(result).toContain('Your Dispatch ID is: ctx_def456')
    expect(result).toContain('Implement the login form')
    expect(result).toContain('There is no interactive coordinator question channel')
    expect(result).not.toContain('orca orchestration')
    expect(result).not.toContain('dispatch-capability')
    expect(result).not.toContain('dcap_must_not_cross_boundary')
    expect(result).not.toContain('heartbeat')
    expect(result).not.toContain('SUB-DISPATCH')
  })

  it('uses orca CLI by default when devMode is not set', () => {
    const result = buildDispatchPreamble(baseParams())
    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
    expect(result).toContain('orca orchestration ask')
  })

  it('uses orca-dev CLI when devMode is true', () => {
    const result = buildDispatchPreamble(baseParams({ devMode: true, cliCommand: 'orca-ide' }))
    expect(result).toContain('orca-dev orchestration send')
    expect(result).toContain('orca-dev orchestration check')
    expect(result).toContain('orca-dev orchestration ask')
    const fragments = result.split('orca-dev')
    for (const fragment of fragments) {
      expect(fragment).not.toMatch(/orca orchestration/)
    }
  })

  it('uses orca CLI when devMode is false', () => {
    const result = buildDispatchPreamble(baseParams({ devMode: false }))
    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
  })

  it('uses the exact orca-ide command for packaged WSL workers', () => {
    const result = buildDispatchPreamble(baseParams({ cliCommand: 'orca-ide' }))

    expect(result).toContain('orca-ide orchestration send')
    expect(result).toContain('orca-ide orchestration check')
    expect(result).toContain('orca-ide orchestration ask')
    expect(result).not.toMatch(/(^|\s)orca orchestration/m)
  })

  it('appends a BASE DRIFT section when baseDrift.behind > 0', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      dispatchId: 'ctx_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      workerHandle: 'term_w',
      baseDrift: {
        base: 'origin/main',
        behind: 7,
        recentSubjects: ['fix: A', 'feat: B', 'chore: C']
      }
    })

    expect(result).toContain('--- BASE DRIFT ---')
    expect(result).toContain('7 commits behind origin/main')
    expect(result).toContain('  - fix: A')
    expect(result).toContain('  - feat: B')
    expect(result).toContain('  - chore: C')
    // drift section must appear before the task spec
    expect(result.indexOf('--- BASE DRIFT ---')).toBeLessThan(result.indexOf('=== TASK ==='))
  })

  it('omits the drift section when baseDrift.behind is 0', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      dispatchId: 'ctx_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      workerHandle: 'term_w',
      baseDrift: {
        base: 'origin/main',
        behind: 0,
        recentSubjects: []
      }
    })

    expect(result).not.toContain('--- BASE DRIFT ---')
    expect(result).not.toContain('commits behind')
  })

  it('omits the drift section when baseDrift is undefined', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      dispatchId: 'ctx_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      workerHandle: 'term_w'
    })

    expect(result).not.toContain('--- BASE DRIFT ---')
    expect(result).not.toContain('commits behind')
  })

  it('lists drift subjects in the order provided, each prefixed with two spaces and dash', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      dispatchId: 'ctx_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      workerHandle: 'term_w',
      baseDrift: {
        base: 'origin/main',
        behind: 3,
        recentSubjects: ['first', 'second', 'third']
      }
    })

    const firstIdx = result.indexOf('  - first')
    const secondIdx = result.indexOf('  - second')
    const thirdIdx = result.indexOf('  - third')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    expect(thirdIdx).toBeGreaterThan(secondIdx)
  })

  it('renders a stable snapshot of the full preamble', () => {
    // Why: single strict snapshot catches any accidental regression in
    // formatting or rule presence in one line.
    const result = buildDispatchPreamble({
      taskId: 'task_SNAP',
      dispatchId: 'ctx_SNAP',
      taskSpec: 'TASK_BODY',
      coordinatorHandle: 'term_COORD',
      workerHandle: 'term_WORKER'
    })
    expect(result).toMatchSnapshot()
  })
})

describe('sub-dispatch section', () => {
  const base = {
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    taskSpec: 'do the thing',
    coordinatorHandle: 'term_coord',
    workerHandle: 'term_worker'
  }

  it('is omitted when the worker has no nesting budget', () => {
    const preamble = buildDispatchPreamble(base)
    expect(preamble).not.toContain('=== SUB-DISPATCH ===')
    expect(preamble).not.toContain('worker-start')
  })

  it('is omitted explicitly when nesting is disallowed', () => {
    expect(buildDispatchPreamble({ ...base, canDispatchSubWorkers: false })).not.toContain(
      '=== SUB-DISPATCH ==='
    )
  })

  it('appears with the run-create sequence when budget remains', () => {
    const preamble = buildDispatchPreamble({ ...base, canDispatchSubWorkers: true })
    expect(preamble).toContain('=== SUB-DISPATCH ===')
    expect(preamble).toContain('orchestration run-create')
    expect(preamble).toContain('orchestration worker-start')
  })

  it('keeps the task block last so the spec is not buried', () => {
    const preamble = buildDispatchPreamble({ ...base, canDispatchSubWorkers: true })
    expect(preamble.indexOf('=== SUB-DISPATCH ===')).toBeLessThan(preamble.indexOf('=== TASK ==='))
  })
})
