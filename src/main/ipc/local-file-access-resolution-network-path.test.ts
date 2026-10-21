import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'
import type { Store } from '../persistence'

// Why win32 paths on every host: a UNC image in a document is a Windows credential leak, and the
// guarantee is that its path text is refused before any filesystem call can reach the network.
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
      // A project image that is really a link to a device name.
      if (String(target).endsWith('share-link.png')) {
        // A local image that is really a link onto a network share.
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
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))

import {
  resolveLocalFileRequestPath,
  resolveLocalRenamePaths,
  resolveLocalRequestPath
} from './local-file-access-resolution'

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

const besideTodo = { kind: 'document-folder', documentPath: 'C:\\Users\\me\\notes\\todo.md' }

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

  it.each(networkTargets)(
    'refuses %s from a document outside every project without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\Users\\me\\notes\\todo.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
    }
  )

  it('refuses it with no declared access too', async () => {
    await expect(resolveLocalFileRequestPath(networkTargets[0], undefined, store)).rejects.toThrow(
      'Access denied'
    )
    expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
  })
})

const CHAT_IMAGE = { kind: 'chat-image' } as const

describe('chat transcript images on Windows', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it.each([...networkTargets, '\\\\.\\C:\\x.png', '//?/C:/x.png'])(
    'refuses %s without touching it',
    async (target) => {
      await expect(resolveLocalFileRequestPath(target, CHAT_IMAGE, store)).rejects.toThrow(
        'Access denied'
      )
      expect(fsCalls).toEqual([])
    }
  )

  it.each([
    'C:\\Users\\me\\Pictures\\shot.png',
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\shot.png',
    '\\\\wsl$\\Ubuntu\\tmp\\agent.webp'
  ])('reads the local image %s in place', async (target) => {
    await expect(resolveLocalFileRequestPath(target, CHAT_IMAGE, store)).resolves.toBe(target)
  })
})

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

  it.each(deviceTargets)(
    'refuses %s from a document beside it without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\Users\\me\\notes\\todo.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls).toEqual([])
    }
  )

  it.each(deviceTargets)(
    'refuses %s as a new file beside an opened document without touching it',
    async (target) => {
      await expect(
        resolveLocalRequestPath(target, besideTodo, store, 'import-into')
      ).rejects.toThrow('Access denied')
      expect(fsCalls).toEqual([])
    }
  )

  it.each([...networkTargets, 'C:\\Users\\me\\other\\shot.png'])(
    'refuses %s outside an opened document folder without touching it',
    async (target) => {
      await expect(
        resolveLocalRequestPath(target, besideTodo, store, 'import-into')
      ).rejects.toThrow('Access denied')
      expect(fsCalls).toEqual([])
    }
  )

  it('still reads an ordinary image whose name only starts like a device', async () => {
    await expect(
      resolveLocalFileRequestPath('C:\\Users\\me\\notes\\console.png', CHAT_IMAGE, store)
    ).resolves.toBe('C:\\Users\\me\\notes\\console.png')
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

  it.each(['C:\\d\\NUL.png\\.', 'C:\\d\\COM1.png\\x\\..', 'C:/d/COM1.jpg/.'])(
    'refuses %s for both access kinds without touching it',
    async (target) => {
      await expect(resolveLocalFileRequestPath(target, CHAT_IMAGE, store)).rejects.toThrow(
        'Access denied'
      )
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\d\\README.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls).toEqual([])
    }
  )

  it('refuses a device name inside a project for automatic loads without touching it', async () => {
    await expect(
      resolveLocalFileRequestPath('C:\\repo\\NUL.png', CHAT_IMAGE, store)
    ).rejects.toThrow('Access denied')
    expect(fsCalls).toEqual([])
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

describe('the default check runs first for every declared kind', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it.each([
    ['user-file', 'read', { kind: 'user-file' }],
    [
      'document-resource',
      'read',
      { kind: 'document-resource', documentPath: 'C:\\repo\\README.md' }
    ],
    ['chat-image', 'read', CHAT_IMAGE],
    ['document-folder', 'import-into', besideTodo]
  ] as const)(
    'never touches a share outside every project while resolving %s %s',
    async (_kind, operation, access) => {
      for (const target of networkTargets) {
        await resolveLocalRequestPath(target, access, store, operation).catch(() => undefined)
      }
      expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
    }
  )

  it('never touches a share while resolving a rename of an opened document', async () => {
    for (const target of networkTargets) {
      await resolveLocalRenamePaths(besideTodo.documentPath, target, besideTodo, store)
    }
    expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
  })
})

const besideShareDocument = {
  kind: 'document-resource',
  documentPath: '\\\\nas\\notes\\todo.md'
}

const besideAccentedShareDocument = {
  kind: 'document-resource',
  documentPath: '\\\\n\u00e1s\\notes\\todo.md'
}

describe('automatic image loads on a network share', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it('reads a chat or document image inside a project the user added from the share', async () => {
    const image = '\\\\server\\share\\repo\\out.png'

    await expect(resolveLocalFileRequestPath(image, CHAT_IMAGE, shareProjectStore)).resolves.toBe(
      image
    )
    await expect(
      resolveLocalFileRequestPath(
        image,
        { kind: 'document-resource', documentPath: '\\\\server\\share\\repo\\README.md' },
        shareProjectStore
      )
    ).resolves.toBe(image)
  })

  it('refuses a local link that leads onto a share outside every project', async () => {
    await expect(
      resolveLocalFileRequestPath('C:\\Users\\me\\share-link.png', CHAT_IMAGE, store)
    ).rejects.toThrow('Access denied')
  })

  it('refuses a chat share image outside every project without touching the share', async () => {
    await expect(
      resolveLocalFileRequestPath('\\\\server\\share\\other\\x.png', CHAT_IMAGE, shareProjectStore)
    ).rejects.toThrow('Access denied')
    expect(fsCalls.filter((call) => call.includes('other'))).toEqual([])
  })

  // Why beside a share document too: a host spelled with a look-alike (U+212A KELVIN SIGN, an NFD
  // accent) can pass a case-folded folder comparison, so no share is loaded outside a project.
  it.each([
    '\\\\nas\\notes\\x.png',
    '\\\\NAS\\Notes\\img\\y.png',
    '//nas/notes/z.png',
    '\\\\nas\\other\\x.png',
    '\\\\evil\\notes\\x.png',
    '\\\\nas\\notes-evil\\x.png',
    '\\\\attacker.example\\share\\x.png'
  ])('refuses %s beside a share document without touching any share', async (target) => {
    await expect(
      resolveLocalFileRequestPath(target, besideShareDocument, shareProjectStore)
    ).rejects.toThrow('Access denied')
    expect(fsCalls).toEqual([])
  })

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

  it('refuses an NFD spelling of an accented share host beside a document on it, without touching it', async () => {
    await expect(
      resolveLocalFileRequestPath(
        '\\\\na\u0301s\\notes\\x.png',
        besideAccentedShareDocument,
        shareProjectStore
      )
    ).rejects.toThrow('Access denied')
    expect(fsCalls).toEqual([])
  })
})
