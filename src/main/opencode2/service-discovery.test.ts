import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOpenCode2AuthHeaders,
  readOpenCode2ServiceInfo,
  resolveOpenCode2ServiceInfoPath
} from './service-discovery'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.unstubAllEnvs()
})

function createStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode2-service-'))
  tempDirs.push(dir)
  return dir
}

describe('resolveOpenCode2ServiceInfoPath', () => {
  it('uses XDG_STATE_HOME when set', () => {
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state')
    expect(resolveOpenCode2ServiceInfoPath()).toBe(join('/xdg/state', 'opencode', 'service.json'))
  })

  it('falls back to ~/.local/state', () => {
    vi.stubEnv('XDG_STATE_HOME', '')
    vi.stubEnv('HOME', '/home/user')
    expect(resolveOpenCode2ServiceInfoPath()).toBe(
      join('/home/user', '.local', 'state', 'opencode', 'service.json')
    )
  })
})

describe('readOpenCode2ServiceInfo', () => {
  it('parses the service registration file', () => {
    const stateDir = createStateDir()
    const servicePath = join(stateDir, 'opencode', 'service.json')
    mkdirSync(join(stateDir, 'opencode'), { recursive: true })
    writeFileSync(
      servicePath,
      JSON.stringify({
        id: 'svc_1',
        version: '0.0.0-next-17288',
        url: 'http://127.0.0.1:4096',
        pid: 1234,
        password: 'sekret'
      }),
      'utf8'
    )

    expect(readOpenCode2ServiceInfo(servicePath)).toEqual({
      id: 'svc_1',
      version: '0.0.0-next-17288',
      url: 'http://127.0.0.1:4096',
      pid: 1234,
      password: 'sekret'
    })
  })

  it('returns null when the file is missing or malformed', () => {
    const stateDir = createStateDir()
    const missing = join(stateDir, 'missing.json')
    const malformed = join(stateDir, 'malformed.json')
    writeFileSync(malformed, 'not json', 'utf8')

    expect(readOpenCode2ServiceInfo(missing)).toBeNull()
    expect(readOpenCode2ServiceInfo(malformed)).toBeNull()
  })

  it('rejects a registration without a url', () => {
    const stateDir = createStateDir()
    const servicePath = join(stateDir, 'opencode', 'service.json')
    mkdirSync(join(stateDir, 'opencode'), { recursive: true })
    writeFileSync(servicePath, JSON.stringify({ id: 'svc_1' }), 'utf8')

    expect(readOpenCode2ServiceInfo(servicePath)).toBeNull()
  })
})

describe('buildOpenCode2AuthHeaders', () => {
  it('emits Basic auth with the opencode username', () => {
    const headers = buildOpenCode2AuthHeaders({ url: 'http://127.0.0.1:4096', password: 'pw' })
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
  })

  it('emits no auth headers when the service has no password', () => {
    expect(buildOpenCode2AuthHeaders({ url: 'http://127.0.0.1:4096' })).toEqual({})
  })
})
