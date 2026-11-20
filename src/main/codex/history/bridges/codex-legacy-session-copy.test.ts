import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as NodeFsPromises from 'node:fs/promises'
import { syncSystemCodexSessionsIntoManagedHomeIncrementally } from './codex-session-bridge'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume
} from '../resume/codex-legacy-session-resume'

const renameHook = vi.hoisted((): { beforeAside: (() => void) | null } => ({ beforeAside: null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (String(to).includes('.orca-legacy-copy.')) {
        renameHook.beforeAside?.()
      }
      return actual.rename(from, to)
    }
  }
})

const THREAD_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const BLOCKED_THREAD_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const RELATIVE_PATH = join('2026', '05', '20', `rollout-2026-05-20T10-00-00-${THREAD_ID}.jsonl`)
const OLD_TURNS = '{"turn":1}\n'
const NEW_TURNS = '{"turn":2}\n'

let root: string
let systemHome: string
let copyPath: string
let sourcePath: string
let markerPath: string

function runtimeHome(): string {
  return join(root, 'user-data', 'codex-runtime-home', 'home')
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** What a pre-2026-05-25 build left: a copy of the source, and a marker of both as copied. */
function legacyCopy(sourceText: string, copyText: string): void {
  writeFile(sourcePath, sourceText)
  writeFile(copyPath, copyText)
  const source = lstatSync(sourcePath)
  const copy = lstatSync(copyPath)
  writeFile(
    markerPath,
    JSON.stringify({
      sourcePath,
      sourceSize: source.size,
      sourceMtimeMs: source.mtimeMs,
      targetSize: copy.size,
      targetMtimeMs: copy.mtimeMs
    })
  )
}

/** The names a swap set the copy's own bytes aside under. */
function asides(): string[] {
  const name = basename(copyPath)
  return readdirSync(dirname(copyPath))
    .filter((entry) => entry.startsWith(`${name}.orca-legacy-copy.`) && !entry.endsWith('.probe'))
    .map((entry) => join(dirname(copyPath), entry))
}

function bridgePass(): Promise<unknown> {
  return syncSystemCodexSessionsIntoManagedHomeIncrementally({ yieldMs: 0 }, systemHome)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-session-copy-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  systemHome = join(root, 'real-codex-home')
  sourcePath = join(systemHome, 'sessions', RELATIVE_PATH)
  copyPath = join(runtimeHome(), 'sessions', RELATIVE_PATH)
  markerPath = join(runtimeHome(), '.orca-session-copies', `${RELATIVE_PATH}.json`)
  renameHook.beforeAside = null
  // A Codex that keeps thread-writer locks ran in the copy's home, and holds none now.
  mkdirSync(join(runtimeHome(), 'thread-writer-locks'), { recursive: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('legacy session copy swap', () => {
  it('keeps writes from a Codex that still has the copy open', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    const writer = openSync(copyPath, 'a')
    try {
      await bridgePass()
      writeSync(writer, '{"late":true}\n')
    } finally {
      closeSync(writer)
    }

    expect(readFileSync(copyPath, 'utf-8')).toBe(OLD_TURNS + NEW_TURNS)
    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
    expect(asides().map((path) => readFileSync(path, 'utf-8'))).toEqual([
      `${OLD_TURNS}{"late":true}\n`
    ])
    expect(existsSync(markerPath)).toBe(false)
  })

  it('keeps a copy holding lines its rewritten source lacks', async () => {
    legacyCopy(NEW_TURNS, OLD_TURNS)

    await bridgePass()

    expect(readFileSync(copyPath, 'utf-8')).toBe(OLD_TURNS)
    expect(lstatSync(copyPath).ino).not.toBe(lstatSync(sourcePath).ino)
    expect(asides()).toEqual([])
    // Older builds match the source by its exact path, so they skip this marker too.
    const kept = JSON.parse(readFileSync(markerPath, 'utf-8'))
    expect(kept.kept).toBe(true)
    expect(kept.sourcePath).not.toBe(sourcePath)
    expect(lstatSync(kept.sourcePath).ino).toBe(lstatSync(sourcePath).ino)
  })

  it('lets later copies through when an earlier copy can never be linked', async () => {
    const blockedRelative = join(
      '2026',
      '05',
      '19',
      `rollout-2026-05-19T10-00-00-${BLOCKED_THREAD_ID}.jsonl`
    )
    const blockedSource = join(systemHome, 'sessions', blockedRelative)
    const blockedCopy = join(runtimeHome(), 'sessions', blockedRelative)
    writeFile(blockedSource, OLD_TURNS)
    writeFile(blockedCopy, OLD_TURNS)
    // As large as a whole pass may read.
    truncateSync(blockedCopy, 64 * 1024 * 1024)
    truncateSync(blockedSource, 64 * 1024 * 1024)
    // Held open by a Codex for good, so it never gets as far as a read.
    writeFile(join(runtimeHome(), 'thread-writer-locks', `${BLOCKED_THREAD_ID}.lock`), '')
    const blocked = lstatSync(blockedCopy)
    writeFile(
      join(runtimeHome(), '.orca-session-copies', `${blockedRelative}.json`),
      JSON.stringify({
        sourcePath: blockedSource,
        sourceSize: blocked.size,
        sourceMtimeMs: lstatSync(blockedSource).mtimeMs,
        targetSize: blocked.size,
        targetMtimeMs: blocked.mtimeMs
      })
    )
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)

    await bridgePass()

    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
    expect(lstatSync(blockedCopy).ino).not.toBe(lstatSync(blockedSource).ino)
  })

  it('swaps the rest of a pass when one copy is larger than a whole pass may read', async () => {
    const largeRelative = join(
      '2026',
      '05',
      '19',
      `rollout-2026-05-19T10-00-00-${BLOCKED_THREAD_ID}.jsonl`
    )
    const largeSource = join(systemHome, 'sessions', largeRelative)
    const largeCopy = join(runtimeHome(), 'sessions', largeRelative)
    writeFile(largeSource, OLD_TURNS)
    writeFile(largeCopy, OLD_TURNS)
    truncateSync(largeCopy, 65 * 1024 * 1024)
    truncateSync(largeSource, 65 * 1024 * 1024)
    const large = lstatSync(largeCopy)
    writeFile(
      join(runtimeHome(), '.orca-session-copies', `${largeRelative}.json`),
      JSON.stringify({
        sourcePath: largeSource,
        sourceSize: large.size,
        sourceMtimeMs: lstatSync(largeSource).mtimeMs,
        targetSize: large.size,
        targetMtimeMs: large.mtimeMs
      })
    )
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)

    await bridgePass()

    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
    expect(lstatSync(largeCopy).ino).not.toBe(lstatSync(largeSource).ino)
  })

  it('leaves a copy alone while a Codex holds its thread lock, and hides it from older builds', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    writeFile(join(runtimeHome(), 'thread-writer-locks', `${THREAD_ID}.lock`), '')

    await bridgePass()

    expect(lstatSync(copyPath).ino).not.toBe(lstatSync(sourcePath).ino)
    // Older builds match the source by its exact path and would swap this copy destructively.
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).sourcePath).not.toBe(sourcePath)
  })

  it('takes no proof of an idle copy from the source home', async () => {
    rmSync(join(runtimeHome(), 'thread-writer-locks'), { recursive: true })
    mkdirSync(join(systemHome, 'thread-writer-locks'), { recursive: true })
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)

    await bridgePass()

    expect(lstatSync(copyPath).ino).not.toBe(lstatSync(sourcePath).ino)
    expect(readFileSync(copyPath, 'utf-8')).toBe(OLD_TURNS)
  })

  it('never renames over a rollout that replaced the copy in the last moment', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    renameHook.beforeAside = () => {
      writeFileSync(`${copyPath}.new`, '{"rewritten":true}\n')
      renameSync(`${copyPath}.new`, copyPath)
    }

    await bridgePass()

    expect(readFileSync(copyPath, 'utf-8')).toBe('{"rewritten":true}\n')
    // The name went back to what was moved; the attempt's aside name stays as a second name.
    expect(asides().map((path) => lstatSync(path).ino)).toEqual([lstatSync(copyPath).ino])
  })

  it('finishes a swap that stopped after moving the copy aside', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    const aside = `${copyPath}.orca-legacy-copy.1`
    writeFileSync(
      markerPath,
      JSON.stringify({ ...JSON.parse(readFileSync(markerPath, 'utf-8')), aside: basename(aside) })
    )
    renameSync(copyPath, aside)

    await bridgePass()

    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
    expect(readFileSync(aside, 'utf-8')).toBe(OLD_TURNS)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('keeps the exact source spelling of a copy written since it was copied', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    writeFileSync(copyPath, `${OLD_TURNS}{"resumed":true}\n`)

    await bridgePass()

    // Older builds skip a changed copy anyway; their usage scan keys its skipped bytes on this path.
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).sourcePath).toBe(sourcePath)
    expect(readFileSync(copyPath, 'utf-8')).toBe(`${OLD_TURNS}{"resumed":true}\n`)
  })

  it('restarts in an account that already holds the copy from before its source grew', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    const accountHome = join(root, 'account-home')
    writeFile(join(accountHome, 'sessions', RELATIVE_PATH), OLD_TURNS)

    await expect(
      prepareCodexAccountRestartResume({
        sourceHome: runtimeHome(),
        transcriptPath: copyPath,
        targetHome: accountHome,
        systemCodexHomePath: systemHome
      })
    ).resolves.toBe(accountHome)
    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
  })

  it('still refuses an account restart onto an older state of a rollout that was never a copy', async () => {
    writeFile(sourcePath, OLD_TURNS + NEW_TURNS)
    const accountHome = join(root, 'account-home')
    writeFile(join(accountHome, 'sessions', RELATIVE_PATH), OLD_TURNS)

    await expect(
      prepareCodexAccountRestartResume({
        sourceHome: systemHome,
        transcriptPath: sourcePath,
        targetHome: accountHome,
        systemCodexHomePath: systemHome
      })
    ).rejects.toThrow()
  })

  it('points the copy at its grown source before a resume launches Codex', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)

    await prepareLegacySharedCodexSessionResume(
      { agent: 'codex', executionHostId: 'local', filePath: copyPath, codexHome: runtimeHome() },
      { isHostSystemDefaultRealHomeSelected: () => false, systemCodexHomePath: systemHome }
    )

    expect(readFileSync(copyPath, 'utf-8')).toBe(OLD_TURNS + NEW_TURNS)
    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
  })
})
