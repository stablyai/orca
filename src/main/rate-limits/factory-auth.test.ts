import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FsState = { files: Map<string, string> }

const fsState: FsState = { files: new Map() }

vi.mock('node:fs', () => ({
  existsSync: (path: string) => fsState.files.has(path),
  readFileSync: (path: string) => {
    const content = fsState.files.get(path)
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return content
  }
}))

vi.mock('../factory/factory-api-key-store', () => ({
  readFactoryApiKey: () => storeState.key
}))

const storeState: { key: string | null } = { key: null }

import { resolveFactoryApiKey } from './factory-auth'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_FILE = join(homedir(), '.factory', '.env')

beforeEach(() => {
  storeState.key = null
  fsState.files.clear()
  delete process.env.FACTORY_API_KEY
})

afterEach(() => {
  delete process.env.FACTORY_API_KEY
})

describe('resolveFactoryApiKey', () => {
  it('returns missing when no source has a key', () => {
    expect(resolveFactoryApiKey()).toEqual({ status: 'missing' })
  })

  it('prefers the Orca store over env and dotenv', () => {
    storeState.key = 'orca-key'
    process.env.FACTORY_API_KEY = 'env-key'
    fsState.files.set(ENV_FILE, 'FACTORY_API_KEY=dotenv-key')
    const result = resolveFactoryApiKey()
    expect(result).toEqual({ status: 'ok', apiKey: 'orca-key', source: 'orca' })
  })

  it('prefers env over dotenv', () => {
    process.env.FACTORY_API_KEY = ' env-key '
    fsState.files.set(ENV_FILE, 'FACTORY_API_KEY=dotenv-key')
    const result = resolveFactoryApiKey()
    expect(result).toEqual({ status: 'ok', apiKey: 'env-key', source: 'env' })
  })

  it('reads a quoted dotenv value and skips comments and blank assignments', () => {
    fsState.files.set(
      ENV_FILE,
      [
        '# comment line',
        'FACTORY_API_KEY=',
        'export FACTORY_API_KEY="dotenv-key"',
        'OTHER_KEY=noise'
      ].join('\n')
    )
    const result = resolveFactoryApiKey()
    expect(result).toEqual({ status: 'ok', apiKey: 'dotenv-key', source: 'dotenv' })
  })

  it('surfaces store decrypt errors', () => {
    storeState.key = null
    vi.doMock('../factory/factory-api-key-store', () => ({
      readFactoryApiKey: () => {
        throw new Error('Factory API key could not be decrypted')
      }
    }))
    vi.resetModules()
    return import('./factory-auth').then(({ resolveFactoryApiKey: resolve }) => {
      const result = resolve()
      expect(result.status).toBe('error')
    })
  })
})
