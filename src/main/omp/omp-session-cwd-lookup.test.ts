import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  io.open.mockImplementation(actual.opendir)
  return { ...actual, opendir: io.open }
})

import { OMP_TRANSCRIPT_IMPORT } from './omp-transcript-import'

const ID = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
const FILE = `2026-10-12T00-00-00-000Z_${ID}.jsonl`
let root = ''
let sessionsDir = ''

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-omp-cwd-')))
  sessionsDir = join(root, 'sessions')
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  io.open.mockReset().mockImplementation(actual.opendir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function record(bucket: string, file = FILE): Promise<string> {
  const dir = join(sessionsDir, bucket)
  await mkdir(dir, { recursive: true })
  const path = join(dir, file)
  await writeFile(path, '{}\n')
  return path
}

async function lookup(cwd = '/repo/orca', homeDir = join(root, 'home'), temp = join(root, 'temp')) {
  const launchEnv = {
    OMP_CODING_AGENT_DIR: sessionsDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: temp,
    TEMP: temp
  }
  const store = OMP_TRANSCRIPT_IMPORT.conversationStore({
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(root, 'account') },
    launchEnv
  })
  return store
    ? OMP_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: ID,
        store,
        workspaceCwd: cwd,
        launchEnv
      })
    : null
}

describe('OMP known-workspace transcript lookup', () => {
  it('finds the reverted SHA256 bucket used by OMP 17.2.5–17.2.8', async () => {
    const windows = process.platform === 'win32'
    const digest = windows
      ? '25910242104f20d3250db9cb42dca52b1ef2afc76aeebbb03cf50c958c3927e9'
      : '5e800b892f87de7d83df9a448eb6a6f9e4c8ce34f082e23cc225a87e622553ac'
    const expected = await record(`abs-orca-${digest}`)
    expect(await lookup(windows ? 'C:\\repo\\orca' : '/repo/orca')).toBe(expected)
  })

  it.skipIf(process.platform === 'win32')(
    'finds the canonical cwd bucket through a workspace alias',
    async () => {
      const home = join(root, 'home')
      const cwd = join(home, 'workspace')
      const alias = join(root, 'alias')
      await mkdir(cwd, { recursive: true })
      await symlink(cwd, alias)
      const expected = await record('-workspace')
      expect(await lookup(alias, home)).toBe(expected)
    }
  )
})
