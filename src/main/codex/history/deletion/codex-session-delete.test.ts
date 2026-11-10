import { zstdCompressSync } from 'node:zlib'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  linkSync,
  lstatSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  readFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { deleteCodexSession } from './codex-session-delete'
import {
  isCodexSessionDeletionRecorded,
  recordCodexSessionDeletion,
  pendingCodexSessionDeletionHomes
} from './codex-session-deletion-record'

vi.mock('../../../ai-vault/cached-session-list', () => ({
  configuredAdditionalCodexHomePaths: () => []
}))
vi.mock('./codex-session-delete-eligibility', () => ({
  canDeleteCodexSession: () => Promise.resolve(true)
}))

const SESSION = '019f0000-1111-7222-8333-000000000001'
const OTHER = '019f0000-1111-7222-8333-000000000002'
const success = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
let root: string
let homes: string[]
let paths: string[]

function rollout(home: string, id = SESSION): string {
  return join(home, 'sessions', '2026', '10', '11', `rollout-2026-10-11T12-00-00-${id}.jsonl`)
}

function writeRollout(path: string, id = SESSION): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ timestamp: '2026-10-11T12:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-10-11T12:00:00Z', cwd: join(root, 'worktree'), originator: 'codex_cli_rs', cli_version: '0.162.1', source: 'cli', model_provider: 'openai' } })}\n`
  )
}

function deleteRun() {
  return vi.fn<typeof runProcess>().mockImplementation(async (spec) => {
    if (spec.args?.includes('--help')) {
      return { ...success, stdout: 'Usage: codex delete [OPTIONS] <SESSION>\n--force' }
    }
    const home = spec.env?.CODEX_HOME
    if (!home) {
      throw new Error('Missing CODEX_HOME')
    }
    rmSync(rollout(home), { force: true })
    rmSync(`${rollout(home)}.zst`, { force: true })
    return success
  })
}

function args() {
  return {
    agent: 'codex' as const,
    sessionId: SESSION,
    filePath: paths[0],
    executionHostId: 'local' as const
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-delete-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca'))
  homes = ['system', 'managed', 'account'].map((name) => join(root, name))
  paths = homes.map((home) => rollout(home))
  writeRollout(paths[0])
  mkdirSync(dirname(paths[1]), { recursive: true })
  linkSync(paths[0], paths[1])
  mkdirSync(dirname(paths[2]), { recursive: true })
  copyFileSync(paths[0], paths[2])
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('Codex session deletion', () => {
  it('refuses an owned session before recording deletion or spawning Codex', async () => {
    const run = deleteRun()
    expect(
      await deleteCodexSession(args(), { homes, run, canDelete: async () => false })
    ).toMatchObject({ outcome: 'failed', detail: 'active' })
    expect(run).not.toHaveBeenCalled()
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
  })
  it('deletes hardlink aliases and legacy copies with the correct home and UUID, preserving other sessions and the worktree', async () => {
    homes.forEach((home) => writeRollout(rollout(home, OTHER), OTHER))
    const worktreeFile = join(root, 'worktree', 'README.md')
    mkdirSync(dirname(worktreeFile), { recursive: true })
    writeFileSync(worktreeFile, 'keep')
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run, command: 'codex' })).toMatchObject({
      outcome: 'deleted',
      filePaths: expect.arrayContaining(paths)
    })
    expect(paths.map(existsSync)).toEqual([false, false, false])
    expect(homes.map((home) => existsSync(rollout(home, OTHER)))).toEqual([true, true, true])
    expect(existsSync(worktreeFile)).toBe(true)
    expect(await isCodexSessionDeletionRecorded(SESSION, true)).toBe(true)
    expect(
      run.mock.calls
        .filter(([spec]) => !spec.args?.includes('--help'))
        .map(([spec]) => ({ args: spec.args, home: spec.env?.CODEX_HOME }))
    ).toEqual(
      [homes[1], homes[2], homes[0]].map((home) => ({
        args: ['delete', SESSION, '--force'],
        home
      }))
    )
  })

  it.each([false, true])(
    'finishes retry when a pending home is deleted (selected: %s)',
    async (selected) => {
      const run = deleteRun().mockResolvedValue({ ...success, code: 1 })
      // Record a validated plan using a successful probe followed by a failed delete.
      run.mockImplementation(async (spec) =>
        spec.args?.includes('--help')
          ? { ...success, stdout: 'Usage: codex delete [OPTIONS] <SESSION>\n--force' }
          : { ...success, code: 1 }
      )
      expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
      const removed = selected ? homes[0] : homes[1]
      rmSync(removed, { recursive: true })
      expect(
        await deleteCodexSession(args(), {
          homes: homes.filter((home) => home !== removed),
          run: deleteRun()
        })
      ).toMatchObject({ outcome: 'deleted' })
      expect(await pendingCodexSessionDeletionHomes(SESSION)).toEqual([])
      expect(existsSync(join(root, 'orca', 'codex-session-deletions', `${SESSION}.pending`))).toBe(
        false
      )
      expect(
        existsSync(join(root, 'orca', 'codex-session-deletions', `${SESSION}.tombstone`))
      ).toBe(true)
    }
  )

  it('does not discard a pending home that still exists but is no longer registered', async () => {
    const run = deleteRun().mockImplementation(async (spec) =>
      spec.args?.includes('--help')
        ? { ...success, stdout: 'Usage: codex delete [OPTIONS] <SESSION>\n--force' }
        : { ...success, code: 1 }
    )
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    const retry = deleteRun()
    expect(
      await deleteCodexSession(args(), { homes: homes.slice(0, 2), run: retry })
    ).toMatchObject({ outcome: 'failed', detail: 'incomplete' })
    expect(retry).not.toHaveBeenCalled()
    expect(existsSync(paths[2])).toBe(true)
    expect(await pendingCodexSessionDeletionHomes(SESSION)).toContain(homes[2])
  })

  it('materializes a selected symlink before the CLI deletes its source home', async () => {
    rmSync(paths[0])
    symlinkSync(paths[2], paths[0], 'file')
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'deleted' })
    expect(paths.map(existsSync)).toEqual([false, false, false])
  })

  it('keeps a materialized symlink retryable after a CLI failure', async () => {
    rmSync(paths[2])
    symlinkSync(paths[0], paths[2], 'file')
    const run = deleteRun().mockImplementation(async (spec) =>
      spec.args?.includes('--help')
        ? { ...success, stdout: 'Usage: codex delete [OPTIONS] <SESSION>\n--force' }
        : { ...success, code: 1 }
    )
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    expect(lstatSync(paths[2]).isFile()).toBe(true)
    expect(readFileSync(paths[2])).toEqual(readFileSync(paths[0]))
    expect(await deleteCodexSession(args(), { homes, run: deleteRun() })).toMatchObject({
      outcome: 'deleted'
    })
  })

  it('rejects a symlink whose target has a different UUID', async () => {
    const other = rollout(homes[0], OTHER)
    writeRollout(other, OTHER)
    rmSync(paths[2])
    symlinkSync(other, paths[2], 'file')
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    expect(run).not.toHaveBeenCalled()
    expect(lstatSync(paths[2]).isSymbolicLink()).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('rejects a symlink pointing outside known Codex homes', async () => {
    const outside = rollout(join(root, 'outside'))
    writeRollout(outside)
    rmSync(paths[2])
    symlinkSync(outside, paths[2], 'file')
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    expect(run).not.toHaveBeenCalled()
    expect(readFileSync(outside)).toEqual(readFileSync(paths[0]))
    expect(lstatSync(paths[2]).isSymbolicLink()).toBe(true)
  })

  it('verifies and deletes a selected compressed rollout alongside its plain aliases', async () => {
    const compressed = `${paths[0]}.zst`
    writeFileSync(compressed, zstdCompressSync(readFileSync(paths[0])))
    rmSync(paths[0])
    const run = deleteRun()
    expect(
      await deleteCodexSession({ ...args(), filePath: compressed }, { homes, run })
    ).toMatchObject({
      outcome: 'deleted',
      filePaths: expect.arrayContaining([compressed, paths[1], paths[2]])
    })
    expect(existsSync(compressed)).toBe(false)
    expect(paths.every((path) => !existsSync(path))).toBe(true)
  })

  it('refuses a compressed alias whose metadata identifies another session', async () => {
    writeRollout(paths[2], OTHER)
    writeFileSync(`${paths[2]}.zst`, zstdCompressSync(readFileSync(paths[2])))
    rmSync(paths[2])
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    expect(run).not.toHaveBeenCalled()
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
  })

  it('deduplicates Codex homes that resolve to the same directory', async () => {
    const alias = join(root, 'alias')
    symlinkSync(homes[0], alias, process.platform === 'win32' ? 'junction' : 'dir')
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes: [...homes, alias], run })).toMatchObject({
      outcome: 'deleted'
    })
    expect(run.mock.calls.filter(([spec]) => !spec.args?.includes('--help'))).toHaveLength(3)
  })

  it('retains a failed cleanup plan and leaves the selected rollout available for retry', async () => {
    const run = deleteRun()
    const execute = run.getMockImplementation()
    run.mockImplementation(async (spec) => {
      if (spec.env?.CODEX_HOME === homes[1] && !spec.args?.includes('--help')) {
        return { ...success, code: 1 }
      }
      if (!execute) {
        throw new Error('Missing executor')
      }
      return execute(spec)
    })
    expect(await deleteCodexSession(args(), { homes, run, command: 'codex' })).toMatchObject({
      outcome: 'failed',
      detail: 'incomplete'
    })
    expect(existsSync(paths[0])).toBe(true)
    expect(await pendingCodexSessionDeletionHomes(SESSION)).toEqual([homes[1], homes[2], homes[0]])
    expect(await isCodexSessionDeletionRecorded(SESSION, true)).toBe(false)
    expect(
      await deleteCodexSession(args(), { homes, run: deleteRun(), command: 'codex' })
    ).toMatchObject({ outcome: 'deleted' })
  })

  it('reports a missing CLI as unsupported without creating a deletion record', async () => {
    const run = vi.fn<typeof runProcess>().mockRejectedValue(new Error('spawn ENOENT'))
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({
      outcome: 'failed',
      detail: 'unsupported'
    })
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
    expect(paths.every(existsSync)).toBe(true)
  })

  it('reports a preflight identity mismatch as an unchanged failure', async () => {
    writeRollout(paths[2], OTHER)
    const run = deleteRun()
    const result = await deleteCodexSession(args(), { homes, run })
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result).not.toHaveProperty('detail')
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(paths.every(existsSync)).toBe(true)
  })

  it('does not record deletion or remove data when the CLI lacks delete --force', async () => {
    const run = vi
      .fn<typeof runProcess>()
      .mockResolvedValue({ ...success, stdout: 'Usage: codex [OPTIONS]' })
    expect(await deleteCodexSession(args(), { homes, run, command: 'codex' })).toMatchObject({
      outcome: 'failed',
      detail: 'unsupported'
    })
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
    expect(paths.every(existsSync)).toBe(true)
  })

  it('does not report success when a successful CLI leaves an alias behind', async () => {
    const run = vi
      .fn<typeof runProcess>()
      .mockResolvedValue({ ...success, stdout: 'Usage: codex delete [OPTIONS] <SESSION>\n--force' })
    expect(await deleteCodexSession(args(), { homes, run, command: 'codex' })).toMatchObject({
      outcome: 'failed',
      detail: 'incomplete'
    })
    expect(await isCodexSessionDeletionRecorded(SESSION, true)).toBe(false)
  })

  it.each(['ssh:box', 'runtime:box'] as const)(
    'rejects %s without running a local command',
    async (executionHostId) => {
      const run = deleteRun()
      expect(
        await deleteCodexSession({ ...args(), executionHostId }, { homes, run })
      ).toMatchObject({ outcome: 'rejected', reason: 'non-local-host' })
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('rejects WSL paths and invalid UUIDs', async () => {
    const run = deleteRun()
    expect(
      await deleteCodexSession(
        { ...args(), filePath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex\\sessions\\x.jsonl' },
        { homes, run }
      )
    ).toMatchObject({ reason: 'non-local-host' })
    expect(
      await deleteCodexSession({ ...args(), sessionId: '--all' }, { homes, run })
    ).toMatchObject({ reason: 'invalid-path' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a filename whose transcript contains a different session identity', async () => {
    writeRollout(paths[2], OTHER)
    const run = deleteRun()
    expect(await deleteCodexSession(args(), { homes, run })).toMatchObject({ outcome: 'failed' })
    expect(run).not.toHaveBeenCalled()
    expect(await isCodexSessionDeletionRecorded(SESSION)).toBe(false)
  })

  it('rejects a sessions directory redirected outside its home', async () => {
    const unsafeHome = join(root, 'unsafe')
    mkdirSync(unsafeHome)
    symlinkSync(
      join(homes[0], 'sessions'),
      join(unsafeHome, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const run = deleteRun()
    expect(
      await deleteCodexSession(
        { ...args(), filePath: rollout(unsafeHome) },
        { homes: [unsafeHome], run }
      )
    ).toMatchObject({ outcome: 'failed' })
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(paths[0])).toBe(true)
  })
})

it
  .skipIf(process.env.ORCA_REAL_CODEX_SESSION_DELETE_TEST !== '1')
  .each(['plain', 'compressed', 'symlink', 'compressed-symlink'])(
  'handles synthetic %s fixtures using the installed Codex CLI',
  async (kind) => {
    const selected = kind === 'compressed' ? `${paths[0]}.zst` : paths[0]
    if (kind === 'compressed') {
      writeFileSync(selected, zstdCompressSync(readFileSync(paths[0])))
      rmSync(paths[0])
    }
    if (kind === 'compressed-symlink') {
      writeFileSync(`${paths[1]}.zst`, zstdCompressSync(readFileSync(paths[1])))
      rmSync(paths[1])
      rmSync(paths[2])
      paths[2] = `${paths[2]}.zst`
      symlinkSync(`${paths[1]}.zst`, paths[2], 'file')
    }
    if (kind === 'symlink') {
      rmSync(paths[2])
      symlinkSync(paths[1], paths[2], 'file')
    }
    homes.forEach((home) => writeRollout(rollout(home, OTHER), OTHER))
    const archived = paths[2].replace('sessions', 'archived_sessions')
    mkdirSync(dirname(archived), { recursive: true })
    renameSync(paths[2], archived)
    const interruptedCopy = join(
      dirname(archived),
      `.orca-delete-${SESSION}-interrupted`,
      archived.split(/[\\/]/).at(-1) ?? ''
    )
    if (kind === 'symlink') {
      mkdirSync(dirname(interruptedCopy), { recursive: true, mode: 0o700 })
      writeFileSync(interruptedCopy, 'partial metadata from an interrupted copy')
      await recordCodexSessionDeletion(SESSION, false, homes)
    }
    const failures: string[] = []
    const result = await deleteCodexSession(
      { ...args(), filePath: selected },
      {
        homes,
        run: async (spec) => {
          // Synthetic homes must not leave persistent Codex daemons behind.
          const commandResult = await runProcess({
            ...spec,
            args: ['--no-daemon', ...(spec.args ?? [])]
          })
          if (commandResult.code !== 0) {
            failures.push(commandResult.stderr)
          }
          return commandResult
        }
      }
    )
    expect({ result, failures }).toMatchObject({ result: { outcome: 'deleted' }, failures: [] })
    expect(paths.every((path) => !existsSync(path))).toBe(true)
    expect(existsSync(archived)).toBe(false)
    expect(existsSync(interruptedCopy)).toBe(false)
    expect(existsSync(`${paths[1]}.zst`)).toBe(false)
    expect(existsSync(selected)).toBe(false)
    expect(homes.every((home) => existsSync(rollout(home, OTHER)))).toBe(true)
  },
  60_000
)
