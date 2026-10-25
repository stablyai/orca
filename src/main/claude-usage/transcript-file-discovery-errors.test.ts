import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { listClaudeTranscriptFiles } from './transcript-file-discovery'

const state = vi.hoisted(() => ({ home: '', blocked: '', code: '' }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => state.home }
})

vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === state.blocked) {
        throw Object.assign(new Error(`Cannot discover ${state.blocked}`), { code: state.code })
      }
      return actual.readdir(...args)
    }
  }
})

let projects: string
let list: typeof listClaudeTranscriptFiles

beforeEach(async () => {
  vi.resetModules()
  state.home = await mkdtemp(join(tmpdir(), 'orca-claude-discovery-error-'))
  state.blocked = ''
  state.code = ''
  projects = join(state.home, '.claude', 'projects')
  await mkdir(projects, { recursive: true })
  await mkdir(join(state.home, '.claude', 'transcripts'), { recursive: true })
  list = (await import('./transcript-file-discovery')).listClaudeTranscriptFiles
})

afterEach(async () => {
  await rm(state.home, { recursive: true, force: true })
})

describe('Claude history discovery failures', () => {
  it.each(['EACCES', 'EPERM', 'EIO', 'UNKNOWN'])(
    'rejects an inaccessible root (%s)',
    async (code) => {
      state.blocked = projects
      state.code = code
      await expect(list([])).rejects.toMatchObject({ code })
    }
  )

  it('rejects an unreadable child instead of reporting that its sibling history disappeared', async () => {
    const sibling = join(projects, 'kept.jsonl')
    await writeFile(sibling, '')
    state.blocked = join(projects, 'inaccessible')
    await mkdir(state.blocked)
    state.code = 'EACCES'
    await expect(list([])).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.each(['ENOENT', 'ENOTDIR'])(
    'keeps sibling files when a child disappears (%s)',
    async (code) => {
      const sibling = join(projects, 'kept.jsonl')
      await writeFile(sibling, '')
      state.blocked = join(projects, 'removed')
      await mkdir(state.blocked)
      state.code = code
      await expect(list([])).resolves.toEqual([sibling])
    }
  )

  it('accepts an absent history root', async () => {
    await rm(projects, { recursive: true })
    await expect(list([])).resolves.toEqual([])
  })
})
