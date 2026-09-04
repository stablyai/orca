import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  DEFAULT_ZAI_ORIGIN,
  isZaiAuthConfigured,
  readZaiCredentials,
  resolveZaiOrigin
} from './zai-credentials'

const AUTH_PATH = join('/home/test', '.local', 'share', 'opencode', 'auth.json')

function writeAuthJson(value: unknown): void {
  fsState.files.set(AUTH_PATH, JSON.stringify(value))
}

describe('resolveZaiOrigin', () => {
  it('defaults to api.z.ai without a record', () => {
    expect(resolveZaiOrigin(null)).toBe(DEFAULT_ZAI_ORIGIN)
    expect(resolveZaiOrigin({})).toBe(DEFAULT_ZAI_ORIGIN)
  })

  it('accepts the record baseURL when it is an allowed origin', () => {
    expect(resolveZaiOrigin({ baseURL: 'https://open.bigmodel.cn/api/anthropic' })).toBe(
      'https://open.bigmodel.cn'
    )
  })

  it('reads nested metadata and config base URLs', () => {
    expect(resolveZaiOrigin({ metadata: { baseURL: 'https://open.bigmodel.cn' } })).toBe(
      'https://open.bigmodel.cn'
    )
    expect(resolveZaiOrigin({ config: { apiBase: 'https://api.z.ai/api/anthropic' } })).toBe(
      DEFAULT_ZAI_ORIGIN
    )
  })

  it('falls back to the default for disallowed or malformed URLs', () => {
    expect(resolveZaiOrigin({ baseURL: 'https://evil.example.com/api/anthropic' })).toBe(
      DEFAULT_ZAI_ORIGIN
    )
    expect(resolveZaiOrigin({ baseURL: '::::not-a-url' })).toBe(DEFAULT_ZAI_ORIGIN)
    expect(resolveZaiOrigin({ baseURL: 42 })).toBe(DEFAULT_ZAI_ORIGIN)
  })
})

describe('readZaiCredentials', () => {
  beforeEach(() => {
    fsState.files.clear()
  })

  it('is missing when no auth.json exists', async () => {
    const result = await readZaiCredentials()
    expect(result).toEqual({ status: 'missing' })
  })

  it('is missing when auth.json has no zai-coding-plan entry', async () => {
    writeAuthJson({ google: { type: 'oauth', access: 'a', expires: 1, refresh: 'r' } })
    const result = await readZaiCredentials()
    expect(result).toEqual({ status: 'missing' })
  })

  it('ignores environment-only credentials', async () => {
    vi.stubEnv('ZAI_API_KEY', 'wallet-key')
    vi.stubEnv('ZAI_CODING_API_KEY', 'coding-key')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'anthropic-key')
    try {
      await expect(readZaiCredentials()).resolves.toEqual({ status: 'missing' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is missing for a nonempty-key record with the wrong type', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'wellknown', key: 'key-1' } })
    const result = await readZaiCredentials()
    expect(result).toEqual({ status: 'missing' })
  })

  it('returns the trimmed key and default origin', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: '  key-1 \n' } })
    const result = await readZaiCredentials()
    expect(result).toEqual({ status: 'ok', key: 'key-1', origin: DEFAULT_ZAI_ORIGIN })
  })

  it('uses the record base URL origin when recognizable', async () => {
    writeAuthJson({
      'zai-coding-plan': {
        type: 'api',
        key: 'key-1',
        metadata: { baseURL: 'https://open.bigmodel.cn/api/anthropic' }
      }
    })
    const result = await readZaiCredentials()
    expect(result).toEqual({ status: 'ok', key: 'key-1', origin: 'https://open.bigmodel.cn' })
  })

  it('surfaces sanitized store errors unchanged', async () => {
    const accessError = new Error('EACCES: permission denied') as NodeJS.ErrnoException
    accessError.code = 'EACCES'
    fsState.files.set(AUTH_PATH, accessError)
    const result = await readZaiCredentials()
    expect(result).toEqual({
      status: 'error',
      error: 'Failed to read OpenCode auth.json (EACCES)'
    })
  })
})

describe('isZaiAuthConfigured', () => {
  beforeEach(() => {
    fsState.files.clear()
  })

  it('is true only for an explicit api record with a nonempty key', async () => {
    expect(await isZaiAuthConfigured()).toBe(false)
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: '' } })
    expect(await isZaiAuthConfigured()).toBe(false)
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-1' } })
    expect(await isZaiAuthConfigured()).toBe(true)
  })

  it('is false when the auth store is unreadable', async () => {
    const parseError = new Error(
      'EISDIR: illegal operation on a directory'
    ) as NodeJS.ErrnoException
    parseError.code = 'EISDIR'
    fsState.files.set(AUTH_PATH, parseError)
    expect(await isZaiAuthConfigured()).toBe(false)
  })
})
