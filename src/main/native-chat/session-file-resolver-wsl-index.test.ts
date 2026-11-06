import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHostModule from '@orca/process-host'
import type * as DiscoveryModule from '../ai-vault/session-scanner-discovery'
import type * as TranscriptFsModule from './wsl-transcript-fs-access'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import SyncDatabase from '../sqlite/sync-database'

const transport = vi.hoisted(() => {
  const state: {
    spawnFails: boolean
    onAdmission: (() => void) | undefined
    refusal: Error | undefined
  } = { spawnFails: false, onAdmission: undefined, refusal: undefined }
  return state
})

// Only WSL transport is adapted: SQLite, directory scanning and metadata parsing stay real.
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHostModule>()
  return {
    ...actual,
    runProcess: (spec: Parameters<typeof actual.runProcess>[0]) => {
      const exec = spec.args?.indexOf('--exec') ?? -1
      if (exec >= 0 && transport.spawnFails) {
        return Promise.reject(new Error('ENOENT'))
      }
      return exec < 0
        ? actual.runProcess(spec)
        : actual.runProcess({
            ...spec,
            program: 'python3',
            args: spec.args!.slice(exec + 2),
            cwd: tmpdir()
          })
    }
  }
})
vi.mock('./wsl-transcript-running-admission', () => ({
  admitWslTranscriptPath: async () => {
    transport.onAdmission?.()
    if (transport.refusal) {
      throw transport.refusal
    }
  }
}))
vi.mock('../ai-vault/session-scanner-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof DiscoveryModule>()
  return {
    ...actual,
    walkSessionFiles: async (
      ...[root, agent, issues, options]: Parameters<typeof actual.walkSessionFiles>
    ) => {
      const wsl = parseWslUncPath(root)
      const files = await actual.walkSessionFiles(wsl?.linuxPath ?? root, agent, issues, options)
      return wsl ? files.map((file) => toWindowsWslUncPath(file, wsl.distro)) : files
    }
  }
})
vi.mock('./wsl-transcript-fs-access', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptFsModule>()
  return {
    ...actual,
    readTranscriptSlice: (...args: Parameters<typeof actual.readTranscriptSlice>) => {
      args[0] = parseWslUncPath(win32.normalize(args[0]))?.linuxPath ?? args[0]
      return actual.readTranscriptSlice(...args)
    },
    openTranscriptReadStream: (...args: Parameters<typeof actual.openTranscriptReadStream>) => {
      args[0] = parseWslUncPath(win32.normalize(args[0]))?.linuxPath ?? args[0]
      return actual.openTranscriptReadStream(...args)
    }
  }
})

import { resolveSessionFilePath } from './session-file-resolver'
import { resetWslTranscriptFsGateForTests, WslTranscriptFsError } from './wsl-transcript-fs-gate'

const homes: string[] = []
afterEach(async () => {
  transport.spawnFails = false
  transport.onAdmission = undefined
  transport.refusal = undefined
  resetWslTranscriptFsGateForTests()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function makeAccount() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-wsl-codex-index-')))
  homes.push(home)
  const sessions = join(home, 'sessions')
  const old = join(sessions, '2026', '10', '01', 'rollout-thread-a.jsonl')
  const head = join(sessions, '2026', '11', '04', 'rollout-thread-a_segment-b.jsonl')
  for (const file of [old, head]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
  }
  return { home, sessions, old, head }
}

function index(home: string, rollout: string, version = 5): void {
  const db = new SyncDatabase(join(home, `state_${version}.sqlite`))
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', rollout)
  } finally {
    db.close()
  }
}

// POSIX files model the Linux guest; real Windows/9P needs a WSL integration host.
describe.skipIf(process.platform === 'win32')(
  'WSL guest index through local POSIX transport',
  () => {
    it('resolves the indexed WSL continuation instead of an older same-ID filename', async () => {
      const { home, sessions, head } = await makeAccount()
      index(home, head)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
        })
      ).resolves.toBe(toWindowsWslUncPath(head, 'Ubuntu'))
    })

    it('keeps filename fallback when the WSL index process cannot start', async () => {
      const { home, sessions, old, head } = await makeAccount()
      index(home, head)
      transport.spawnFails = true
      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
        })
      ).resolves.toBe(toWindowsWslUncPath(old, 'Ubuntu'))
    })

    it('returns the canonical admitted file when UNC dot normalization would read a foreign account', async () => {
      const { home, sessions } = await makeAccount()
      const safe = join(sessions, 'secret.jsonl')
      const foreign = join(home, 'another-account')
      await mkdir(join(sessions, 'subdir'))
      await mkdir(foreign)
      for (const file of [safe, join(foreign, 'secret.jsonl')]) {
        await writeFile(file, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
      }
      await symlink(join(sessions, 'subdir'), join(foreign, 'alias'))
      index(home, `${foreign}/alias/../secret.jsonl`)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
        })
      ).resolves.toBe(toWindowsWslUncPath(safe, 'Ubuntu'))
    })

    it('refuses canonical guest filenames that cannot be addressed safely through Windows UNC', async () => {
      const { home, sessions, old } = await makeAccount()
      const target = join(sessions, 'literal\\backslash.jsonl')
      const alias = join(sessions, 'alias.jsonl')
      await writeFile(target, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
      await symlink(target, alias)
      index(home, alias)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
        })
      ).resolves.toBe(toWindowsWslUncPath(old, 'Ubuntu'))
    })

    it('uses the numerically latest database and accepts WSL share aliases', async () => {
      const { home, sessions, old, head } = await makeAccount()
      index(home, old, 9)
      index(home, toWindowsWslUncPath(head, 'uBunTu').replace('wsl.localhost', 'wsl$'), 10)
      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [
            toWindowsWslUncPath(sessions, 'Ubuntu').replace('wsl.localhost', 'wsl$')
          ]
        })
      ).resolves.toBe(toWindowsWslUncPath(head, 'Ubuntu'))
    })

    it.each([
      'no database',
      'missing',
      'corrupt',
      'mismatched metadata',
      'foreign distro',
      'foreign account',
      'symlink escape'
    ])('falls back within the requested account for an unusable index: %s', async (kind) => {
      const { home, sessions, old, head } = await makeAccount()
      let candidate = head
      if (kind === 'missing') {
        candidate = join(sessions, 'gone.jsonl')
      }
      if (kind === 'mismatched metadata') {
        await writeFile(head, '{"type":"session_meta","payload":{"id":"other-thread"}}\n')
      }
      if (kind === 'foreign distro') {
        candidate = toWindowsWslUncPath(head, 'Debian')
      }
      if (kind === 'foreign account' || kind === 'symlink escape') {
        const foreign = `${sessions}-foreign`
        await mkdir(foreign)
        const file = join(foreign, 'rollout-thread-a.jsonl')
        await writeFile(file, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
        candidate = file
        if (kind === 'symlink escape') {
          await symlink(foreign, join(sessions, 'linked'))
          candidate = join(sessions, 'linked', 'rollout-thread-a.jsonl')
        }
      }
      if (kind === 'corrupt') {
        await writeFile(join(home, 'state_5.sqlite'), 'not SQLite')
      } else if (kind !== 'no database') {
        index(home, candidate)
      }
      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')],
          strictErrors: true
        })
      ).resolves.toBe(toWindowsWslUncPath(old, 'Ubuntu'))
    })

    it('reads the current indexed continuation while commits are in SQLite WAL', async () => {
      const { home, sessions, head } = await makeAccount()
      const db = new SyncDatabase(join(home, 'state_5.sqlite'))
      try {
        db.exec(
          'PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)'
        )
        db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', head)
        await expect(
          resolveSessionFilePath('codex', 'thread-a', {
            codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
          })
        ).resolves.toBe(toWindowsWslUncPath(head, 'Ubuntu'))
      } finally {
        db.close()
      }
    })

    it('preserves caller cancellation instead of falling back to old WSL history', async () => {
      const { sessions } = await makeAccount()
      const controller = new AbortController()
      const reason = new Error('cancelled by caller')
      transport.onAdmission = () => controller.abort(reason)
      await expect(
        resolveSessionFilePath(
          'codex',
          'thread-a',
          {
            codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
          },
          controller.signal
        )
      ).rejects.toBe(reason)
    })

    it('preserves a stopped-distro refusal instead of returning old WSL history', async () => {
      const { sessions } = await makeAccount()
      const refusal = new WslTranscriptFsError('unavailable', 'distro stopped')
      transport.refusal = refusal
      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [toWindowsWslUncPath(sessions, 'Ubuntu')]
        })
      ).rejects.toBe(refusal)
    })
  }
)
