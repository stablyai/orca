import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted<{ files: Map<string, string | Error> }>(() => ({
  files: new Map()
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const entry = fsState.files.get(String(path))
    if (entry === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, open ${path}`
      ) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    if (entry instanceof Error) {
      throw entry
    }
    return entry
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import {
  getOpenCodeApiKeyRecord,
  getOpenCodeAuthJsonCandidates,
  readOpenCodeAuthJson
} from './opencode-auth-store'

// Built with `join` so expectations match the separator emitted on this platform.
function expectedPath(...segments: string[]): string {
  return join(...segments)
}

describe('getOpenCodeAuthJsonCandidates', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lists APPDATA, XDG, Linux default, macOS default in precedence order', () => {
    const candidates = getOpenCodeAuthJsonCandidates(
      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', XDG_DATA_HOME: '/xdg' },
      '/home/test'
    )
    expect(candidates).toEqual([
      expectedPath('C:\\Users\\u\\AppData\\Roaming', 'opencode', 'auth.json'),
      expectedPath('/xdg', 'opencode', 'auth.json'),
      expectedPath('/home/test', '.local', 'share', 'opencode', 'auth.json'),
      expectedPath('/home/test', 'Library', 'Application Support', 'opencode', 'auth.json')
    ])
  })

  it('skips unset environment variables', () => {
    const candidates = getOpenCodeAuthJsonCandidates({}, '/home/test')
    expect(candidates).toEqual([
      expectedPath('/home/test', '.local', 'share', 'opencode', 'auth.json'),
      expectedPath('/home/test', 'Library', 'Application Support', 'opencode', 'auth.json')
    ])
  })

  it('dedupes candidates that resolve to the same path, keeping the first', () => {
    const candidates = getOpenCodeAuthJsonCandidates(
      { APPDATA: '/shared', XDG_DATA_HOME: '/shared' },
      '/home/test'
    )
    expect(candidates).toEqual([
      expectedPath('/shared', 'opencode', 'auth.json'),
      expectedPath('/home/test', '.local', 'share', 'opencode', 'auth.json'),
      expectedPath('/home/test', 'Library', 'Application Support', 'opencode', 'auth.json')
    ])
  })
})

describe('readOpenCodeAuthJson', () => {
  beforeEach(() => {
    fsState.files.clear()
  })

  it('prefers the first readable candidate', async () => {
    fsState.files.set(
      expectedPath('/appdata', 'opencode', 'auth.json'),
      JSON.stringify({ source: 'appdata' })
    )
    fsState.files.set(
      expectedPath('/home/test', '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ source: 'linux-default' })
    )
    const result = await readOpenCodeAuthJson({ APPDATA: '/appdata' }, '/home/test')
    expect(result).toEqual({ status: 'ok', auth: { source: 'appdata' } })
  })

  it('returns missing when no candidate exists', async () => {
    const result = await readOpenCodeAuthJson({}, '/home/test')
    expect(result).toEqual({ status: 'missing' })
  })

  it('continues past ENOTDIR to the next candidate', async () => {
    const notDir = new Error('ENOTDIR: not a directory') as NodeJS.ErrnoException
    notDir.code = 'ENOTDIR'
    fsState.files.set(expectedPath('/appdata', 'opencode', 'auth.json'), notDir)
    fsState.files.set(
      expectedPath('/home/test', '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ source: 'linux-default' })
    )
    const result = await readOpenCodeAuthJson({ APPDATA: '/appdata' }, '/home/test')
    expect(result).toEqual({ status: 'ok', auth: { source: 'linux-default' } })
  })

  it('reports a sanitized error without the path for unreadable files', async () => {
    const accessError = new Error('EACCES: permission denied') as NodeJS.ErrnoException
    accessError.code = 'EACCES'
    fsState.files.set(expectedPath('/appdata', 'opencode', 'auth.json'), accessError)
    const result = await readOpenCodeAuthJson({ APPDATA: '/appdata' }, '/home/test')
    expect(result).toEqual({ status: 'error', error: 'Failed to read OpenCode auth.json (EACCES)' })
  })

  it('reports invalid JSON without echoing file contents', async () => {
    fsState.files.set(
      expectedPath('/appdata', 'opencode', 'auth.json'),
      '{"secret-key-value": trun'
    )
    const result = await readOpenCodeAuthJson({ APPDATA: '/appdata' }, '/home/test')
    expect(result).toEqual({ status: 'error', error: 'OpenCode auth.json is not valid JSON' })
  })

  it('rejects non-object JSON documents', async () => {
    fsState.files.set(expectedPath('/appdata', 'opencode', 'auth.json'), '["not-a-record"]')
    const result = await readOpenCodeAuthJson({ APPDATA: '/appdata' }, '/home/test')
    expect(result).toEqual({ status: 'error', error: 'OpenCode auth.json is invalid' })
  })
})

describe('getOpenCodeApiKeyRecord', () => {
  it('accepts an explicit api record with a nonempty key', () => {
    expect(
      getOpenCodeApiKeyRecord(
        { 'zai-coding-plan': { type: 'api', key: ' key-1 ' } },
        'zai-coding-plan'
      )
    ).toEqual({ type: 'api', key: ' key-1 ' })
  })

  it('rejects other auth entry shapes', () => {
    const auth = {
      wellknown: { type: 'wellknown', key: 'k' },
      empty: { type: 'api', key: '   ' },
      missingKey: { type: 'api' },
      nonStringKey: { type: 'api', key: 42 },
      arrayEntry: ['api'],
      nullEntry: null
    }
    for (const [providerId] of Object.entries(auth)) {
      expect(getOpenCodeApiKeyRecord(auth, providerId)).toBeNull()
    }
  })
})
