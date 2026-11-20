import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncSystemCodexSessionsIntoManagedHomeIncrementally } from './codex-session-bridge'
import { prepareLegacySharedCodexSessionResume } from '../resume/codex-legacy-session-resume'

const THREAD_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
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
  // A Codex that keeps thread-writer locks, with none held.
  mkdirSync(join(systemHome, 'thread-writer-locks'), { recursive: true })
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
    expect(readFileSync(`${copyPath}.orca-legacy-copy`, 'utf-8')).toBe(
      `${OLD_TURNS}{"late":true}\n`
    )
    expect(existsSync(markerPath)).toBe(false)
  })

  it('keeps a copy holding lines its rewritten source lacks', async () => {
    legacyCopy(NEW_TURNS, OLD_TURNS)

    await bridgePass()

    expect(readFileSync(copyPath, 'utf-8')).toBe(OLD_TURNS)
    expect(lstatSync(copyPath).ino).not.toBe(lstatSync(sourcePath).ino)
    expect(existsSync(markerPath)).toBe(false)
    expect(existsSync(`${markerPath}.kept`)).toBe(true)
    expect(existsSync(`${copyPath}.orca-legacy-copy`)).toBe(false)
  })

  it('leaves a copy alone while a Codex holds its thread lock', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    writeFile(join(systemHome, 'thread-writer-locks', `${THREAD_ID}.lock`), '')

    await bridgePass()

    expect(lstatSync(copyPath).ino).not.toBe(lstatSync(sourcePath).ino)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('finishes a swap that stopped after linking both spare names', async () => {
    legacyCopy(OLD_TURNS + NEW_TURNS, OLD_TURNS)
    linkSync(copyPath, `${copyPath}.orca-legacy-copy`)
    linkSync(sourcePath, `${copyPath}.orca-legacy-link`)

    await bridgePass()

    expect(lstatSync(copyPath).ino).toBe(lstatSync(sourcePath).ino)
    expect(readFileSync(`${copyPath}.orca-legacy-copy`, 'utf-8')).toBe(OLD_TURNS)
    expect(existsSync(`${copyPath}.orca-legacy-link`)).toBe(false)
    expect(existsSync(markerPath)).toBe(false)
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
