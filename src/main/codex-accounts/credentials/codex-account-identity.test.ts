import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexAccountIdentity } from './codex-account-identity'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-identity-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('OPENAI_API_KEY', undefined)
  vi.stubEnv('ORCA_CODEX_HOME', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it('reports login from the user CODEX_HOME before the default directory', () => {
  const defaultHome = join(home, '.codex')
  const customHome = join(home, 'custom codex')
  mkdirSync(defaultHome)
  mkdirSync(customHome)
  writeFileSync(join(defaultHome, 'auth.json'), '{"auth_mode":"apikey"}')
  const customAuthPath = join(customHome, 'auth.json')
  writeFileSync(customAuthPath, '{"auth_mode":"chatgpt","tokens":{"account_id":"custom-account"}}')
  vi.stubEnv('CODEX_HOME', customHome)
  const identity = new CodexAccountIdentity((path) => path)

  expect(identity.resolveSystemDefault(null)).toMatchObject({
    hasAuth: true,
    authKind: 'oauth',
    providerAccountId: 'custom-account'
  })

  rmSync(customAuthPath)
  expect(identity.resolveSystemDefault(null)).toMatchObject({ hasAuth: false, authKind: 'none' })

  vi.stubEnv('ORCA_CODEX_HOME', customHome)
  expect(identity.resolveSystemDefault(null)).toMatchObject({ hasAuth: true, authKind: 'api-key' })

  vi.stubEnv('CODEX_HOME', undefined)
  expect(identity.resolveSystemDefault(null)).toMatchObject({ hasAuth: true, authKind: 'api-key' })
})
