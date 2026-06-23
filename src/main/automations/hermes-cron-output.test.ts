import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let hermesHome: string | null = null
let extraTempDirs: string[] = []
const previousHermesHome = process.env.HERMES_HOME
const fakeDbRows = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[]
}))
const fakePrepareSqls = vi.hoisted(() => [] as string[])
const fakeDatabase = vi.hoisted(() =>
  vi.fn(function FakeDatabase() {
    return {
      prepare: vi.fn((sql: string) => {
        fakePrepareSqls.push(sql)
        return {
          get: vi.fn((param: string) =>
            sql.includes('FROM sessions')
              ? fakeDbRows.sessions.find((session) => session.id === param)
              : undefined
          ),
          all: vi.fn((param: string) =>
            sql.includes('FROM sessions')
              ? fakeDbRows.sessions
              : fakeDbRows.messages.filter((message) => message.session_id === param)
          )
        }
      }),
      close: vi.fn()
    }
  })
)

vi.mock('../sqlite/sync-database', () => ({
  default: fakeDatabase
}))

async function loadReader() {
  vi.resetModules()
  return import('./hermes-cron-output')
}

async function createHermesHome(): Promise<string> {
  hermesHome = await mkdtemp(join(tmpdir(), 'orca-hermes-output-'))
  process.env.HERMES_HOME = hermesHome
  return hermesHome
}

beforeEach(() => {
  fakeDbRows.sessions = []
  fakeDbRows.messages = []
  fakePrepareSqls.length = 0
  fakeDatabase.mockClear()
})

afterEach(async () => {
  if (previousHermesHome === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = previousHermesHome
  }
  if (hermesHome) {
    await rm(hermesHome, { recursive: true, force: true })
    hermesHome = null
  }
  await Promise.all(extraTempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  extraTempDirs = []
  vi.resetModules()
})

describe('readHermesCronOutputRunsPage', () => {
  it('attaches the state.db transcript to the matching Hermes output file run', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const scriptLogPath = join(home, 'Automations', 'x-automation', 'logs', 'x-monitor.log')
    await mkdir(outputDir, { recursive: true })
    await mkdir(dirname(scriptLogPath), { recursive: true })
    await writeFile(scriptLogPath, 'raw script log line\nsecond raw script log line\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

**Job ID:** job-1

## Response

Success — ./run-x-monitor.sh completed with exit code 0.
Latest log path: ${scriptLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    await writeFile(join(home, 'state.db'), '', 'utf-8')
    fakeDbRows.sessions = [
      {
        id: 'cron_job-1_20260515_090000',
        title: 'Monitor automation',
        started_at: Date.UTC(2026, 4, 15, 9, 0, 0) / 1000,
        ended_at: Date.UTC(2026, 4, 15, 9, 1, 58) / 1000,
        model: 'gpt-5',
        message_count: 2,
        input_tokens: 100,
        output_tokens: 50
      }
    ]
    fakeDbRows.messages = [
      {
        session_id: 'cron_job-1_20260515_090000',
        role: 'tool',
        content: 'full command output line',
        tool_name: 'terminal',
        timestamp: Date.UTC(2026, 4, 15, 9, 1, 0) / 1000
      }
    ]

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect(page.total).toBe(1)
    expect(page.runs[0]).toMatchObject({
      id: 'job-1:2026-05-15_09-02-00.md',
      status: 'completed',
      output_path: join(outputDir, '2026-05-15_09-02-00.md')
    })
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'monitor automation completed successfully.'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'raw script log line'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Full session log'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'full command output line'
    )
  })

  it('builds large response previews without broad regex captures', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      [
        '# Cron Job: Monitor automation',
        '',
        '## Response',
        '',
        '```',
        'hidden-token\n'.repeat(500),
        '```',
        '',
        'Visible response text '.repeat(500),
        ''
      ].join('\n'),
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const execSpy = vi.spyOn(RegExp.prototype, 'exec')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })
    const usedBroadCapture = execSpy.mock.contexts.some(
      (pattern) => pattern instanceof RegExp && pattern.source.includes('[\\s\\S]')
    )
    const usedWhitespaceReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
    )

    expect(usedBroadCapture).toBe(false)
    expect(usedWhitespaceReplace).toBe(false)
    expect((page.runs[0] as { output_preview?: string }).output_preview).toContain(
      'Visible response text'
    )
    expect((page.runs[0] as { output_preview?: string }).output_preview).not.toContain(
      'hidden-token'
    )
  })

  it('does not hydrate referenced logs outside Hermes home', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const outsideDir = await mkdtemp(join(tmpdir(), 'orca-hermes-outside-'))
    extraTempDirs.push(outsideDir)
    const outsideLogPath = join(outsideDir, 'secret.log')
    await mkdir(outputDir, { recursive: true })
    await writeFile(outsideLogPath, 'do not expose this\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

## Response

Latest log path: ${outsideLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect((page.runs[0] as { output_content?: string }).output_content).not.toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).not.toContain(
      'do not expose this'
    )
  })

  it('hydrates referenced logs in valid dot-dot-prefixed Hermes subdirectories', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const scriptLogPath = join(home, '..logs', 'x-monitor.log')
    await mkdir(outputDir, { recursive: true })
    await mkdir(dirname(scriptLogPath), { recursive: true })
    await writeFile(scriptLogPath, 'dot-dot-prefixed log line\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

## Response

Latest log path: ${scriptLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'dot-dot-prefixed log line'
    )
  })

  it('uses a count-only path when page size is zero', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      'this content should not be read for count-only listing',
      'utf-8'
    )
    await writeFile(join(home, 'state.db'), '', 'utf-8')
    fakeDbRows.sessions = [
      {
        id: 'cron_job-1_20260515_090000',
        started_at: Date.UTC(2026, 4, 15, 9, 0, 0) / 1000
      }
    ]
    fakeDbRows.messages = [
      {
        session_id: 'cron_job-1_20260515_090000',
        role: 'tool',
        content: 'full command output line'
      }
    ]

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })

    expect(page).toEqual({ total: 1, runs: [] })
    expect(fakePrepareSqls.some((sql) => sql.includes('FROM messages'))).toBe(false)
  })

  it('caches count-only reads until the cache is cleared', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, '2026-05-15_09-02-00.md'), 'first run', 'utf-8')

    const { clearHermesCronOutputRunCountCache, readHermesCronOutputRunsPage } = await loadReader()
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    await writeFile(join(outputDir, '2026-05-15_09-03-00.md'), 'second run', 'utf-8')
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    clearHermesCronOutputRunCountCache('job-1')
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 2,
      runs: []
    })
  })

  it('evicts oldest count cache entries when many job ids are observed', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-0')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, '2026-05-15_09-02-00.md'), 'first run', 'utf-8')

    const { readHermesCronOutputRunsPage } = await loadReader()
    await expect(readHermesCronOutputRunsPage('job-0', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    for (let i = 1; i <= 200; i += 1) {
      await readHermesCronOutputRunsPage(`job-${i}`, { page: 1, pageSize: 0 })
    }
    await writeFile(join(outputDir, '2026-05-15_09-03-00.md'), 'second run', 'utf-8')

    await expect(readHermesCronOutputRunsPage('job-0', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 2,
      runs: []
    })
  })
})
