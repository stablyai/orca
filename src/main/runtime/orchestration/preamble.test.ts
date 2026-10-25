import { spawnSync } from 'node:child_process'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble, CHAT_REDISPATCH_PARAGRAPH as CHAT_REDISPATCH } from './preamble'

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

function cliFence(result: string): string {
  const match = result.match(/=== CLI COMMANDS ===\n\n```sh\n([\s\S]*?)\n```/)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

function markdownBlocks(result: string) {
  const tree = unified().use(remarkParse).parse(result)
  return {
    headings: tree.children.filter((node) => node.type === 'heading'),
    codeBlocks: tree.children.filter((node) => node.type === 'code')
  }
}

const driftParams = { base: 'origin/main', behind: 3, recentSubjects: ['fix: a', 'feat: b'] }

describe('buildDispatchPreamble', () => {
  it(
    'CLI examples parse as valid shell (bash -n on the extracted block)',
    { timeout: 15_000 },
    () => {
      const result = buildDispatchPreamble(baseParams())
      const check = spawnSync('bash', ['-n'], { input: cliFence(result), encoding: 'utf8' })
      expect(check.status).toBe(0)
    }
  )

  it('renders every injected lifecycle command on one cross-shell-safe line', () => {
    const result = buildDispatchPreamble(baseParams())
    const commandLines = result
      .split('\n')
      .filter((line) => line.trimStart().startsWith('orca orchestration'))

    expect(commandLines).toHaveLength(5)
    expect(result).not.toContain('\\\n')
    expect(commandLines.filter((line) => line.includes('--type worker_done'))).toHaveLength(1)
    expect(commandLines.filter((line) => line.includes('--type heartbeat'))).toHaveLength(1)
    expect(commandLines.filter((line) => line.includes('orchestration ask'))).toHaveLength(1)
    expect(commandLines.filter((line) => line.includes('--type escalation'))).toHaveLength(1)
  })

  it('fences shell comments so Markdown does not promote them to headings', () => {
    const result = buildDispatchPreamble(baseParams())
    const { headings, codeBlocks } = markdownBlocks(result)

    expect(headings).toHaveLength(0)
    expect(codeBlocks).toHaveLength(1)
    expect(codeBlocks[0]).toMatchObject({ lang: 'sh', value: cliFence(result) })
  })

  // Why: a `---` rule directly under a paragraph is a setext H2, so the optional
  // sections' closing rules must not turn their last sentence into a heading.
  it('renders no Markdown headings when the sub-dispatch and drift sections are present', () => {
    const result = buildDispatchPreamble(
      baseParams({ canDispatchSubWorkers: true, baseDrift: driftParams })
    )
    const { headings, codeBlocks } = markdownBlocks(result)

    expect(headings).toHaveLength(0)
    expect(codeBlocks).toHaveLength(2)
    expect(codeBlocks[1]).toMatchObject({ lang: 'sh' })
    expect(codeBlocks[1].value).toContain('orchestration worker-start --from')
    expect(result).toContain('helpers of their own.\n\n---')
    expect(result).toContain('before starting.\n\n---')
  })

  it('sub-dispatch fence passes bash -n', { timeout: 15_000 }, () => {
    const result = buildDispatchPreamble(baseParams({ canDispatchSubWorkers: true }))
    const { codeBlocks } = markdownBlocks(result)
    const check = spawnSync('bash', ['-n'], { input: codeBlocks[1].value, encoding: 'utf8' })
    expect(check.status).toBe(0)
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

  it('renders a stable snapshot of a chat worker preamble', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_SNAP',
      dispatchId: 'ctx_SNAP',
      taskSpec: 'TASK_BODY',
      coordinatorHandle: 'orca_session_id:COORD',
      workerHandle: 'orca_session_id:WORKER'
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

  it('is omitted explicitly when nesting is disallowed', () => {
    expect(buildDispatchPreamble({ ...base, canDispatchSubWorkers: false })).not.toContain(
      '=== SUB-DISPATCH ==='
    )
  })

  it('starts helpers on this Dispatch, without a Run of their own, when budget remains', () => {
    const preamble = buildDispatchPreamble({ ...base, canDispatchSubWorkers: true })
    expect(preamble).toContain('=== SUB-DISPATCH ===')
    expect(preamble).toContain('orchestration worker-start --from term_worker --spec')
    expect(preamble).not.toContain('orchestration run-create')
  })

  it('keeps the task block last so the spec is not buried', () => {
    const preamble = buildDispatchPreamble({ ...base, canDispatchSubWorkers: true })
    expect(preamble.indexOf('=== SUB-DISPATCH ===')).toBeLessThan(preamble.indexOf('=== TASK ==='))
  })
})

describe('how the preamble names the worker and its coordinator, by kind', () => {
  const SESSION_COORD = 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
  const SESSION_WORKER = 'orca_session_id:7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
  const header = (preamble: string) => preamble.slice(0, preamble.indexOf('\n\n'))
  const FIRST = 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.'

  it("follows each party's own kind when a session and a terminal meet", () => {
    expect(header(buildDispatchPreamble(baseParams({ workerHandle: SESSION_WORKER })))).toBe(
      `${FIRST}\nYour coordinator's terminal handle is: term_coord\nYour task ID is: task_abc123\nYour Orca session ID is: ${SESSION_WORKER}`
    )
    expect(header(buildDispatchPreamble(baseParams({ coordinatorHandle: SESSION_COORD })))).toBe(
      `${FIRST}\nYour coordinator's Orca session ID is: ${SESSION_COORD}\nYour task ID is: task_abc123`
    )
  })

  it('tells a chat worker nothing about a terminal or a shell, even as a bare-shell worker', () => {
    for (const workerKind of ['prompt-returning-agent', 'bare-shell'] as const) {
      const chat = buildDispatchPreamble(baseParams({ workerHandle: SESSION_WORKER, workerKind }))

      expect(chat).not.toContain('this terminal')
      expect(chat).not.toContain('exit the shell')
      expect(chat).not.toContain('Exit the shell')
      expect(chat).not.toContain('Your terminal')
      expect(chat).toContain('return to an idle prompt')
      expect(chat).toContain(`check --terminal ${SESSION_WORKER}`)
      expect(afterWorkerDoneSection(chat).trimEnd().endsWith(CHAT_REDISPATCH)).toBe(true)
    }
  })
})
