import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backfillManagedCodexSessionsIntoSystemHome } from './codex-session-backfill'
import type { CodexSessionBackfillPaths } from './codex-session-backfill-types'

const ROLLOUT_NAME = 'rollout-2026-05-26T10-00-00-0f0e0d0c-0b0a-4908-8706-050403020100.jsonl'
const ROLLOUT_RELATIVE_PATH = join('2026', '05', '26', ROLLOUT_NAME)
const ROLLOUT_CONTENTS = '{"type":"session_meta"}\n'

let tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

type ArchiveRig = {
  paths: CodexSessionBackfillPaths
  managedPath: string
  activePath: string
  archivedSessionsRoot: string
}

function createArchiveRig(): ArchiveRig {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-session-archive-'))
  tempRoots.push(root)
  const systemCodexHome = join(root, 'home', '.codex')
  const paths: CodexSessionBackfillPaths = {
    managedSessionsRoot: join(root, 'managed-home', 'sessions'),
    systemSessionsRoot: join(systemCodexHome, 'sessions'),
    auditLogPath: join(root, 'state', 'audit.jsonl'),
    markerPath: join(root, 'state', 'backfill-complete.json')
  }
  const managedPath = join(paths.managedSessionsRoot, ROLLOUT_RELATIVE_PATH)
  mkdirSync(dirname(managedPath), { recursive: true })
  writeFileSync(managedPath, ROLLOUT_CONTENTS, 'utf-8')
  return {
    paths,
    managedPath,
    activePath: join(paths.systemSessionsRoot, ROLLOUT_RELATIVE_PATH),
    archivedSessionsRoot: join(systemCodexHome, 'archived_sessions')
  }
}

/** Mirrors `fs::rename` into Codex's flat archive directory. */
function archiveRollout(rig: ArchiveRig, fileName = ROLLOUT_NAME): string {
  const archivedPath = join(rig.archivedSessionsRoot, fileName)
  mkdirSync(rig.archivedSessionsRoot, { recursive: true })
  writeFileSync(archivedPath, ROLLOUT_CONTENTS, 'utf-8')
  return archivedPath
}

describe('archived Codex sessions and the managed-home backfill', () => {
  it('does not republish a rollout the user archived in Codex', async () => {
    const rig = createArchiveRig()
    archiveRollout(rig)

    const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

    expect(existsSync(rig.activePath)).toBe(false)
    expect(summary).toMatchObject({ linkedFiles: 0, skippedArchivedFiles: 1, failedFiles: 0 })
  })

  it('treats a compressed archived rollout as archived', async () => {
    const rig = createArchiveRig()
    archiveRollout(rig, `${ROLLOUT_NAME}.zst`)

    const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

    expect(existsSync(rig.activePath)).toBe(false)
    expect(summary.linkedFiles).toBe(0)
  })

  it('still publishes a rollout that was never archived', async () => {
    const rig = createArchiveRig()
    mkdirSync(rig.archivedSessionsRoot, { recursive: true })
    archiveRollout(rig, 'rollout-2026-05-26T09-00-00-11112222-3333-4444-8555-666677778888.jsonl')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

    expect(existsSync(rig.activePath)).toBe(true)
    expect(summary.linkedFiles).toBe(1)
  })

  it('drops the redundant active hardlink an earlier republication left behind', async () => {
    const rig = createArchiveRig()
    mkdirSync(dirname(rig.activePath), { recursive: true })
    mkdirSync(rig.archivedSessionsRoot, { recursive: true })
    const archivedPath = join(rig.archivedSessionsRoot, ROLLOUT_NAME)
    linkSync(rig.managedPath, archivedPath)
    linkSync(rig.managedPath, rig.activePath)

    const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

    expect(existsSync(rig.activePath)).toBe(false)
    expect(lstatSync(archivedPath).ino).toBe(lstatSync(rig.managedPath).ino)
    expect(summary.failedFiles).toBe(0)
  })

  it('keeps an unrelated active file that merely shares the archived name', async () => {
    const rig = createArchiveRig()
    archiveRollout(rig)
    mkdirSync(dirname(rig.activePath), { recursive: true })
    writeFileSync(rig.activePath, '{"type":"session_meta","other":true}\n', 'utf-8')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

    expect(existsSync(rig.activePath)).toBe(true)
    expect(summary.failedFiles).toBe(0)
  })

  // ENOTDIR is the portable POSIX signal for an unreadable archive location;
  // Windows reports the same shape as a missing path, which is a different case.
  it.skipIf(process.platform === 'win32')(
    'fails the file closed when the archive location cannot be read',
    async () => {
      const rig = createArchiveRig()
      mkdirSync(dirname(rig.archivedSessionsRoot), { recursive: true })
      writeFileSync(rig.archivedSessionsRoot, 'not a directory\n', 'utf-8')

      const summary = await backfillManagedCodexSessionsIntoSystemHome(rig.paths)

      expect(existsSync(rig.activePath)).toBe(false)
      expect(summary).toMatchObject({ linkedFiles: 0, failedFiles: 1 })
    }
  )
})
