import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ managed: '', system: '', blocked: '', code: '' }))

vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => state.managed,
  getSystemCodexHomePath: () => state.system
}))

vi.mock('../codex/codex-account-home-discovery', () => ({
  getCodexAccountHomeSessionDirectories: () => []
}))

vi.mock('../codex/codex-session-bridge', () => ({
  getLegacyCopiedCodexSessionBridgeScanPreference: () => null
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

import { listCodexSessionFiles } from './codex-session-file-discovery'

let root: string
let sessions: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-discovery-error-'))
  state.managed = join(root, 'managed')
  state.system = join(root, 'system')
  state.blocked = ''
  state.code = ''
  sessions = join(state.managed, 'sessions')
  await mkdir(sessions, { recursive: true })
  await mkdir(join(state.system, 'sessions'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Codex history discovery failures', () => {
  it.each(['EACCES', 'EPERM', 'EIO', 'UNKNOWN'])(
    'rejects an inaccessible root (%s)',
    async (code) => {
      state.blocked = sessions
      state.code = code
      await expect(listCodexSessionFiles()).rejects.toMatchObject({ code })
    }
  )

  it('rejects an unreadable child instead of publishing an incomplete history list', async () => {
    await writeFile(join(sessions, 'kept.jsonl'), '')
    state.blocked = join(sessions, 'inaccessible')
    await mkdir(state.blocked)
    state.code = 'EACCES'
    await expect(listCodexSessionFiles()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.each(['ENOENT', 'ENOTDIR'])(
    'keeps sibling files when a child disappears (%s)',
    async (code) => {
      const sibling = join(sessions, 'kept.jsonl')
      await writeFile(sibling, '')
      state.blocked = join(sessions, 'removed')
      await mkdir(state.blocked)
      state.code = code
      await expect(listCodexSessionFiles()).resolves.toEqual([sibling])
    }
  )

  it('accepts absent homes while preserving the available history', async () => {
    const sibling = join(sessions, 'kept.jsonl')
    await writeFile(sibling, '')
    await rm(state.system, { recursive: true })
    await expect(listCodexSessionFiles()).resolves.toEqual([sibling])
  })
})
