import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'
import type { Store } from '../../../persistence/loading-store/store'

// Use Windows paths on every host to prove UNC credential-leak rejection happens before filesystem access.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

const { fsCalls } = vi.hoisted(() => {
  const calls: string[] = []
  return { fsCalls: calls }
})

vi.mock('node:fs/promises', () => {
  const record = (name: string) =>
    vi.fn(async (target: unknown) => {
      fsCalls.push(`${name} ${String(target)}`)
      if (name !== 'realpath') {
        return { isFile: () => true, isDirectory: () => false }
      }
      // A project-local name resolving to a device.
      if (String(target).endsWith('share-link.png')) {
        // A local image resolving to a network share.
        return '\\\\nas\\pics\\shot.png'
      }
      return String(target).endsWith('dev-link.png') ? 'C:\\repo\\CON.png' : target
    })
  return { realpath: record('realpath'), stat: record('stat'), open: record('open') }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    statSync: vi.fn((target: unknown) => {
      fsCalls.push(`statSync ${String(target)}`)
      throw new Error('statSync is not expected')
    })
  }
})
vi.mock('electron', () => ({ app: { getPath: () => 'C:\\Users\\me\\AppData\\Roaming\\Orca' } }))
vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreeGraph: vi.fn(async () => [])
}))
import { resolveLocalFileRequestPath } from './local-file-access-resolution'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const store = {
  getRepos: () => [
    { id: 'repo', path: 'C:\\repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const networkTargets = [
  '\\\\attacker.example\\share\\x.png',
  '//attacker.example/share/x.png',
  '\\\\?\\UNC\\attacker.example\\share\\x.png'
]

describe('document images on a network share', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it.each(networkTargets)(
    'refuses %s from a project document without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\repo\\README.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
    }
  )
})

const CHAT_IMAGE = { kind: 'chat-image' } as const

describe('Windows reserved device names in automatic image loads', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  const deviceTargets = [
    'C:\\Users\\me\\notes\\NUL.png',
    'C:\\Users\\me\\notes\\com1.jpg',
    'C:\\Users\\me\\notes\\Lpt9 .gif',
    'C:\\Users\\me\\notes\\aux..png',
    'C:\\Users\\me\\notes\\CON.tar.png',
    'C:\\Users\\me\\notes\\NUL:.png',
    'C:\\Users\\me\\notes\\COM1:.png',
    'C:\\Users\\me\\notes\\NUL:stream.png',
    'C:\\Users\\me\\notes\\CONIN$.png',
    'C:\\Users\\me\\notes\\CONOUT$',
    'C:\\Users\\me\\notes\\clock$.jpg',
    'C:\\Users\\me\\notes\\COM0.png',
    'C:\\Users\\me\\notes\\LPT0.png',
    'C:\\Users\\me\\notes\\com¹.png'
  ]

  it.each(deviceTargets)('refuses %s as a chat image without touching it', async (target) => {
    await expect(resolveLocalFileRequestPath(target, CHAT_IMAGE, store)).rejects.toThrow(
      'Access denied'
    )
    expect(fsCalls).toEqual([])
  })
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const shareProjectStore = {
  getRepos: () => [
    {
      id: 'repo',
      path: '\\\\server\\share\\repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
  ],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

describe('automatic image loads and dot segments that resolve to a device name', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it('refuses a project image whose real target is a device name', async () => {
    await expect(
      resolveLocalFileRequestPath(
        'C:\\repo\\dev-link.png',
        { kind: 'document-resource', documentPath: 'C:\\repo\\README.md' },
        store
      )
    ).rejects.toThrow('Access denied')
  })
})

describe('automatic image loads on a network share', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  // Unicode look-alike hosts must not bypass path-text rejection beside share documents.

  it.each(['\\\\bac\u212Aup\\notes\\x.png', '//bac\u212Aup/notes/x.png'])(
    'refuses the KELVIN SIGN host spelling %s beside a document on \\\\backup without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: '\\\\backup\\notes\\todo.md' },
          shareProjectStore
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls).toEqual([])
    }
  )
})
