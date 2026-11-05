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

  it('fences shell comments so Markdown does not promote them to headings', () => {
    const result = buildDispatchPreamble(baseParams())
    const { headings, codeBlocks } = markdownBlocks(result)

    expect(headings).toHaveLength(0)
    expect(codeBlocks).toHaveLength(1)
    expect(codeBlocks[0]).toMatchObject({ lang: 'sh', value: cliFence(result) })
  })

  // A closing rule directly below prose becomes a setext heading; keep a blank line.
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
})

describe('how the preamble names the worker and its coordinator, by kind', () => {
  const SESSION_WORKER = 'orca_session_id:7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'

  it('tells a chat worker nothing about a terminal or a shell, even as a bare-shell worker', () => {
    for (const workerKind of ['prompt-returning-agent', 'bare-shell'] as const) {
      const chat = buildDispatchPreamble(baseParams({ workerHandle: SESSION_WORKER, workerKind }))

      expect(chat).not.toContain('this terminal')
      expect(chat).not.toContain('exit the shell')
      expect(chat).not.toContain('Exit the shell')
      expect(chat).not.toContain('Your terminal')
      expect(chat).toContain('return to an idle prompt')
      expect(chat).toContain(`--from ${SESSION_WORKER}`)
      expect(afterWorkerDoneSection(chat).trimEnd().endsWith(CHAT_REDISPATCH)).toBe(true)
    }
  })
})
