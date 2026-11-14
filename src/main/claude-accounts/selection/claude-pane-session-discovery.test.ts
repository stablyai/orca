import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverClaudePaneSession,
  discoverLocalPtyClaudeSession,
  type ClaudeSessionProcessRow
} from './claude-pane-session-discovery'

type HostDouble = {
  ptys: { ptyId: string; pid: number }[]
  router: null | { accountHomes: () => string[]; systemDefaultHome: () => string }
  readTable: ReturnType<typeof vi.fn>
}

const host = vi.hoisted((): HostDouble => ({ ptys: [], router: null, readTable: vi.fn() }))
vi.mock('../../memory/pty-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listRegisteredPtys: () => host.ptys
}))
vi.mock('../profiles/routing/claude-profile-installed-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClaudeProfileRouter: () => host.router
}))
vi.mock('../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWindowsProcessTableFresh: host.readTable
}))

const CREATED_MS = 1_700_000_000_000
const CREATED_AS_FILETIME = '133444736000001234'
const SESSION_ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0'
const CWD = 'C:\\work\\repo'
const BUCKET = 'C--work-repo'
const CLAUDE_COMMAND = '"C:\\tools\\claude.exe" --dangerously-skip-permissions --resume'
const toFiletime = (ms: number): string => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n)

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pane-session-'))
  roots.push(dir)
  return dir
}

function writeRawRecord(dir: string, pid: number, text: string): void {
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'sessions', `${pid}.json`), text)
}

function writeRecord(dir: string, pid: number, record: Record<string, unknown>): void {
  writeRawRecord(dir, pid, JSON.stringify(record))
}

function writeTranscript(dir: string): string {
  const bucket = join(dir, 'projects', BUCKET)
  mkdirSync(bucket, { recursive: true })
  const path = join(bucket, `${SESSION_ID}.jsonl`)
  writeFileSync(path, '{}\n')
  return path
}

function paneRows(command = CLAUDE_COMMAND, createdMs = CREATED_MS): ClaudeSessionProcessRow[] {
  return [
    { pid: 100, ppid: 1, command: 'pwsh.exe -NoLogo', creationTimeMs: CREATED_MS - 60_000 },
    { pid: 200, ppid: 100, command, creationTimeMs: createdMs },
    { pid: 300, ppid: 200, command: 'bash.exe -c "pnpm test"', creationTimeMs: CREATED_MS + 5_000 },
    { pid: 400, ppid: 300, command: 'node.exe vitest', creationTimeMs: CREATED_MS + 6_000 }
  ]
}

const record = {
  pid: 200,
  sessionId: SESSION_ID,
  cwd: CWD,
  procStart: CREATED_AS_FILETIME,
  kind: 'interactive',
  entrypoint: 'cli'
}

function accountWithSession(): string {
  const dir = configDir()
  writeRecord(dir, 200, record)
  writeTranscript(dir)
  return dir
}

const discover = (rows: ClaudeSessionProcessRow[], configDirs: string[]) =>
  discoverClaudePaneSession({ rootPid: 100, rows, configDirs })

describe('discoverClaudePaneSession', () => {
  it("names the session from the record in the account folder of the pane's agent process", async () => {
    const account = configDir()
    writeRecord(account, 200, record)
    const transcriptPath = writeTranscript(account)

    expect(await discover(paneRows(), [configDir(), account])).toEqual({
      key: 'session_id',
      id: SESSION_ID,
      transcriptPath,
      cwd: CWD,
      permissionMode: 'bypassPermissions'
    })
  })

  it('ignores a record whose process start time belongs to another process with that pid', async () => {
    const account = accountWithSession()

    expect(await discover(paneRows(CLAUDE_COMMAND, CREATED_MS + 60_000), [account])).toBeNull()
    expect((await discover(paneRows(), [account]))?.id).toBe(SESSION_ID)
  })

  it('ignores a record naming another pid, and one whose transcript is gone', async () => {
    const renamed = configDir()
    writeRecord(renamed, 200, { ...record, pid: 201 })
    writeTranscript(renamed)
    const noTranscript = configDir()
    writeRecord(noTranscript, 200, record)

    expect(await discover(paneRows(), [renamed])).toBeNull()
    expect(await discover(paneRows(), [noTranscript])).toBeNull()
  })

  it('ignores an agent process that started before the shell it claims as parent', async () => {
    const olderMs = CREATED_MS - 120_000
    const account = configDir()
    writeRecord(account, 200, { ...record, procStart: toFiletime(olderMs) })
    writeTranscript(account)

    expect(await discover(paneRows(CLAUDE_COMMAND, olderMs), [account])).toBeNull()
  })

  it.each([
    ['the shell', 100],
    ['a process between the shell and the agent', 150]
  ])('names no session when %s has no start time', async (_label, untimedPid) => {
    const account = accountWithSession()
    const rows = [
      ...paneRows().map((row) => (row.pid === 200 ? { ...row, ppid: 150 } : row)),
      { pid: 150, ppid: 100, command: 'cmd.exe /c claude', creationTimeMs: CREATED_MS - 30_000 }
    ]
    const untimed = rows.map((row) =>
      row.pid === untimedPid ? { ...row, creationTimeMs: undefined } : row
    )

    expect((await discover(rows, [account]))?.id).toBe(SESSION_ID)
    expect(await discover(untimed, [account])).toBeNull()
  })

  it.each([
    ['another kind', { kind: 'background' }],
    ['another entrypoint', { entrypoint: 'sdk' }],
    ['no kind', { kind: undefined }],
    ['no entrypoint', { entrypoint: undefined }]
  ])('ignores a record with %s', async (_label, change) => {
    const account = configDir()
    writeRecord(account, 200, { ...record, ...change })
    writeTranscript(account)

    expect(await discover(paneRows(), [account])).toBeNull()
  })

  it.each([
    ['beside it', 100],
    ['below its tool child', 300]
  ])('names no session when a second agent process %s carries a record', async (_label, ppid) => {
    const account = accountWithSession()
    const secondMs = CREATED_MS + 10_000
    writeRecord(account, 500, { ...record, pid: 500, procStart: toFiletime(secondMs) })
    const rows = [...paneRows(), { pid: 500, ppid, command: 'claude', creationTimeMs: secondMs }]

    expect(await discover(rows, [account])).toBeNull()
  })

  it('still names the session when a second agent process has no record', async () => {
    const account = accountWithSession()
    const rows = [
      ...paneRows(),
      { pid: 500, ppid: 100, command: 'claude', creationTimeMs: CREATED_MS + 10_000 }
    ]

    expect((await discover(rows, [account]))?.id).toBe(SESSION_ID)
  })

  it.each([
    ['no procStart', JSON.stringify({ ...record, procStart: undefined })],
    ['a procStart that is not a number', JSON.stringify({ ...record, procStart: '13344e7' })],
    ['a session id that is not a string', JSON.stringify({ ...record, sessionId: 42 })],
    ['corrupt JSON', '{"pid": 200,'],
    ['JSON that is not an object', '[200]']
  ])('names no session for a record with %s', async (_label, text) => {
    const account = configDir()
    writeRawRecord(account, 200, text)
    writeTranscript(account)

    expect(await discover(paneRows(), [account])).toBeNull()
  })

  it('names no session when the process has no start time or the shell is not in the table', async () => {
    const account = accountWithSession()
    const rows = paneRows().map((row) =>
      row.pid === 200 ? { ...row, creationTimeMs: undefined } : row
    )

    expect(await discover(rows, [account])).toBeNull()
    expect(
      await discoverClaudePaneSession({ rootPid: 999, rows: paneRows(), configDirs: [account] })
    ).toBeNull()
  })
})

describe('discoverClaudePaneSession launch flags', () => {
  const settingsOf = async (command: string) => {
    const found = await discover(paneRows(command), [accountWithSession()])
    return { model: found?.model, effort: found?.effort, permissionMode: found?.permissionMode }
  }

  it('keeps the effort and permission mode the command line chose in either spelling', async () => {
    expect(await settingsOf('claude --effort high --permission-mode=plan --resume')).toEqual({
      model: undefined,
      effort: 'high',
      permissionMode: 'plan'
    })
    expect((await settingsOf('claude --permission-mode plan')).permissionMode).toBe('plan')
  })

  it('keeps the model the command line chose in either spelling, and none without the flag', async () => {
    expect((await settingsOf('claude --model lane-model-7 --effort high')).model).toBe(
      'lane-model-7'
    )
    expect((await settingsOf('claude --model=lane-model-7 --resume')).model).toBe('lane-model-7')
    expect((await settingsOf('claude --effort high --resume')).model).toBeUndefined()
  })

  it('keeps a model id carrying a version, a region path and a context suffix', async () => {
    expect((await settingsOf('claude --model vertex-x@2025:a/b[1m]')).model).toBe(
      'vertex-x@2025:a/b[1m]'
    )
  })

  it('takes the last value of a repeated flag', async () => {
    expect(
      await settingsOf(
        'claude --model lane-model-1 --model=lane-model-2 --effort low --effort high'
      )
    ).toEqual({ model: 'lane-model-2', effort: 'high', permissionMode: undefined })
  })

  it('reads no flag after the -- terminator', async () => {
    expect(
      await settingsOf(
        'claude --resume -- --model lane-model-7 --effort high --dangerously-skip-permissions'
      )
    ).toEqual({ model: undefined, effort: undefined, permissionMode: undefined })
  })
})

describe('discoverLocalPtyClaudeSession', () => {
  const platform = process.platform
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })

  beforeEach(() => {
    const account = accountWithSession()
    const systemDefault = configDir()
    host.ptys = [{ ptyId: 'pty-1', pid: 100 }]
    host.router = { accountHomes: () => [account], systemDefaultHome: () => systemDefault }
    host.readTable.mockReset().mockResolvedValue(paneRows())
    setPlatform('win32')
  })
  afterEach(() => setPlatform(platform))

  it('names the session of a registered Windows pane', async () => {
    expect((await discoverLocalPtyClaudeSession('pty-1'))?.id).toBe(SESSION_ID)
  })

  it('finds a record in the system default folder', async () => {
    const systemDefault = configDir()
    writeRecord(systemDefault, 200, record)
    writeTranscript(systemDefault)
    host.router = { accountHomes: () => [configDir()], systemDefaultHome: () => systemDefault }

    expect((await discoverLocalPtyClaudeSession('pty-1'))?.id).toBe(SESSION_ID)
  })

  it('reads nothing off Windows', async () => {
    setPlatform('linux')

    expect(await discoverLocalPtyClaudeSession('pty-1')).toBeNull()
    expect(host.readTable).not.toHaveBeenCalled()
  })

  it('names no session for an unregistered pane, without accounts, or when the table fails', async () => {
    expect(await discoverLocalPtyClaudeSession('pty-2')).toBeNull()
    host.readTable.mockRejectedValue(new Error('table unavailable'))
    expect(await discoverLocalPtyClaudeSession('pty-1')).toBeNull()
    host.router = null
    expect(await discoverLocalPtyClaudeSession('pty-1')).toBeNull()
  })
})
