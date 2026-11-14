import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_API_ENDPOINT_FILE,
  normalizeClaudeApiEndpointRequest,
  readClaudeApiEndpointEnv,
  readClaudeApiEndpointToken,
  writeClaudeApiEndpoint
} from './claude-api-endpoint'

const REQUEST = {
  label: ' Sakana AI ',
  baseUrl: 'https://api.sakana.ai/',
  authToken: ' test-token ',
  model: 'fugu',
  smallFastModel: ''
}

const roots: string[] = []
function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-api-endpoint-')))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude API endpoint accounts', () => {
  it('trims fields, drops the trailing slash and runs background tasks on the main model', () => {
    expect(normalizeClaudeApiEndpointRequest(REQUEST)).toEqual({
      label: 'Sakana AI',
      baseUrl: 'https://api.sakana.ai',
      authToken: 'test-token',
      model: 'fugu',
      smallFastModel: 'fugu'
    })
  })

  it('refuses plain http except for a local gateway', () => {
    expect(() =>
      normalizeClaudeApiEndpointRequest({ ...REQUEST, baseUrl: 'http://api.example.test' })
    ).toThrow('https')
    expect(
      normalizeClaudeApiEndpointRequest({ ...REQUEST, baseUrl: 'http://localhost:4000/' }).baseUrl
    ).toBe('http://localhost:4000')
    expect(() => normalizeClaudeApiEndpointRequest({ ...REQUEST, baseUrl: 'api.example' })).toThrow(
      'full URL'
    )
  })

  it('keeps the saved token when the edit leaves it blank, and needs one otherwise', () => {
    const edit = { ...REQUEST, authToken: '' }
    expect(normalizeClaudeApiEndpointRequest(edit, 'saved-token').authToken).toBe('saved-token')
    expect(() => normalizeClaudeApiEndpointRequest(edit)).toThrow('token')
  })

  it('stores the endpoint owner-only and turns it into the env Claude Code reads', () => {
    const folder = home()
    expect(readClaudeApiEndpointEnv(folder)).toBeNull()
    const summary = writeClaudeApiEndpoint(folder, {
      ...normalizeClaudeApiEndpointRequest(REQUEST),
      smallFastModel: 'fugu-mini'
    })
    expect(summary).toEqual({
      baseUrl: 'https://api.sakana.ai',
      model: 'fugu',
      smallFastModel: 'fugu-mini'
    })
    if (process.platform !== 'win32') {
      expect(statSync(join(folder, CLAUDE_API_ENDPOINT_FILE)).mode & 0o777).toBe(0o600)
    }
    expect(readClaudeApiEndpointToken(folder)).toBe('test-token')
    expect(readClaudeApiEndpointEnv(folder)).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.sakana.ai',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_MODEL: 'fugu',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'fugu',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'fugu',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fugu-mini',
      ANTHROPIC_SMALL_FAST_MODEL: 'fugu-mini'
    })
  })

  it('rejects a damaged endpoint file', () => {
    const folder = home()
    writeFileSync(join(folder, CLAUDE_API_ENDPOINT_FILE), '{"baseUrl":""}')
    expect(() => readClaudeApiEndpointEnv(folder)).toThrow()
  })
})
