import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import { planOpenCodeConfig } from './chrome-devtools-opencode'

const roots: string[] = []
function fixture(contents?: string, name = 'opencode.jsonc') {
  const home = mkdtempSync(join(tmpdir(), 'orca-mcp-test-'))
  roots.push(home)
  const file = join(home, '.config', 'opencode', name)
  mkdirSync(dirname(file), { recursive: true })
  if (contents !== undefined) {
    writeFileSync(file, contents)
  }
  return { home, file }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Chrome DevTools OpenCode config', () => {
  it('preserves comments, trailing commas, unrelated MCP servers, and remains idempotent', () => {
    const original =
      '{\n // keep my settings\n "model": "custom/model",\n "mcp": { "other": { "type": "local", "command": ["other"] }, },\n}\n'
    const { home, file } = fixture(original)
    const plan = planOpenCodeConfig(home, {}, 'linux')
    expect(plan.configPath).toBe(file)
    expect(plan.after).toContain('// keep my settings')
    expect(parse(plan.after)).toMatchObject({
      model: 'custom/model',
      mcp: { other: { command: ['other'] }, 'chrome-devtools': { enabled: true, timeout: 60000 } }
    })
    expect(readFileSync(file, 'utf8')).toBe(original)
    writeFileSync(file, plan.after)
    expect(planOpenCodeConfig(home, {}, 'linux').after).toBe(plan.after)
  })
  it('preserves an earlier compatible registration without the optional CrUX privacy flag', () => {
    const { home, file } = fixture()
    const initial = planOpenCodeConfig(home, {}, 'linux').after
    const previous = initial.replace(/,?\s*"--no-performance-crux"/, '')
    writeFileSync(file, previous)
    expect(planOpenCodeConfig(home, {}, 'linux').after).toBe(previous)
  })
  it('uses XDG config and ignores a managed OpenCode overlay as a destination', () => {
    const { home } = fixture()
    const configRoot = join(home, 'xdg')
    expect(
      planOpenCodeConfig(
        home,
        { XDG_CONFIG_HOME: configRoot, OPENCODE_CONFIG_DIR: '/managed' },
        'linux'
      ).configPath
    ).toBe(join(configRoot, 'opencode', 'opencode.json'))
  })
  it('uses the documented Windows command wrapper', () => {
    const { home } = fixture()
    const value = parse(planOpenCodeConfig(home, {}, 'win32').after)
    expect(value.mcp['chrome-devtools'].command.slice(0, 5)).toEqual([
      'cmd',
      '/c',
      'npx',
      '-y',
      'chrome-devtools-mcp@latest'
    ])
  })
  it.each([
    '{"mcp":',
    '{"mcp":{},"mcp":{}}',
    '{"mcp":false}',
    '{"mcp":{"servers":{}}}',
    '{"$schema":"https://example.com/v2"}',
    '{"mcp":{"chrome-devtools":{"enabled":false}}}'
  ])('rejects invalid, duplicate, v2, or conflicting config: %s', (contents) => {
    const { home, file } = fixture(contents)
    expect(() => planOpenCodeConfig(home, {}, 'linux')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })
  it.each([
    { type: 'local', command: ['my-server'] },
    { type: 'remote', url: 'https://example.com/mcp' }
  ])('preserves a v1 server literally named servers: %j', (server) => {
    const original = JSON.stringify({ mcp: { servers: server } })
    const { home, file } = fixture(original)
    const plan = planOpenCodeConfig(home, {}, 'linux')
    expect(parse(plan.after).mcp.servers).toEqual(server)
    expect(parse(plan.after).mcp['chrome-devtools'].type).toBe('local')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })
  it('rejects the v2 nested server map without modifying it', () => {
    const original = JSON.stringify({
      mcp: { servers: { browser: { type: 'local', command: ['my-server'] } } }
    })
    const { home, file } = fixture(original)
    expect(() => planOpenCodeConfig(home, {}, 'linux')).toThrow('v2 mcp.servers')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })
  it('rejects ambiguous file precedence and explicit content/file overrides', () => {
    const { home, file } = fixture('{}')
    writeFileSync(join(dirname(file), 'opencode.json'), '{}')
    expect(() => planOpenCodeConfig(home, {}, 'linux')).toThrow('Both')
    expect(() => planOpenCodeConfig(home, { OPENCODE_CONFIG: '/override' }, 'linux')).toThrow(
      'overrides'
    )
  })
})
