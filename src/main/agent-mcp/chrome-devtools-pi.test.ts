import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { planPiConfig } from './chrome-devtools-pi'
import { configureChromeDevtools } from './chrome-devtools-setup'

const roots: string[] = []
function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orca-pi-mcp-test-'))
  roots.push(home)
  const agentDir = join(home, '.pi', 'agent')
  const hostRoot = join(home, 'host', 'node_modules', '@earendil-works', 'pi-coding-agent')
  const aiRoot = join(hostRoot, 'node_modules', '@earendil-works', 'pi-ai')
  const adapterRoot = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter')
  const program = join(home, 'bin', 'pi')
  write(
    program,
    '#!/bin/sh\nexec node "$basedir/../host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n'
  )
  chmodSync(program, 0o755)
  write(
    join(hostRoot, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.84.1' })
  )
  write(join(hostRoot, 'dist', 'cli.js'), 'throw new Error("Do not execute Pi during setup")')
  write(
    join(aiRoot, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-ai',
      version: '0.84.1',
      exports: { './compat': './compat.js' }
    })
  )
  write(join(aiRoot, 'compat.js'), 'throw new Error("Do not import host AI runtime")')
  const semverRoot = dirname(createRequire(__filename).resolve('semver/package.json'))
  symlinkSync(semverRoot, join(hostRoot, 'node_modules', 'semver'), 'junction')
  write(
    join(adapterRoot, 'package.json'),
    JSON.stringify({
      name: 'pi-mcp-adapter',
      version: '2.32.1',
      pi: { extensions: ['./index.ts'] },
      peerDependencies: { '@earendil-works/pi-ai': '^0.84.1 || ^0.85.0' }
    })
  )
  write(join(adapterRoot, 'index.ts'), 'throw new Error("Do not execute the extension")')
  write(
    join(adapterRoot, 'sampling-handler.ts'),
    'import { complete } from "@earendil-works/pi-ai/compat"'
  )
  write(join(agentDir, 'settings.json'), '{"packages":["npm:pi-mcp-adapter"]}')
  return { home, agentDir, hostRoot, aiRoot, adapterRoot, env: { PATH: dirname(program) }, program }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Pi Chrome DevTools setup prerequisites', () => {
  it('validates npm/pnpm metadata without running Pi or extension, preserves config and backup', async () => {
    const { home, agentDir, env } = fixture()
    const config = join(agentDir, 'mcp.json')
    const before = '{\n // my server\n "mcpServers": {"other": {"command":"other"}}\n}\n'
    write(config, before)
    const preview = planPiConfig(home, env, 'linux')
    expect(preview.prerequisite).toEqual({
      hostVersion: '0.84.1',
      adapterVersion: '2.32.1',
      validation: 'installed-metadata; extension-load-not-checked'
    })
    expect(readFileSync(config, 'utf8')).toBe(before)
    const result = await configureChromeDevtools({
      agent: 'pi',
      apply: true,
      home,
      env,
      platform: 'linux'
    })
    expect(readFileSync(result.configs[0].backupPath!, 'utf8')).toBe(before)
    expect(readFileSync(config, 'utf8')).toContain('// my server')
    expect(planPiConfig(home, env, 'linux').before).toBe(planPiConfig(home, env, 'linux').after)
  })
  it('uses Orca source directory instead of managed PI_CODING_AGENT_DIR', () => {
    const { home, agentDir, env } = fixture()
    const managed = join(home, 'managed')
    expect(
      planPiConfig(
        home,
        { ...env, ORCA_PI_SOURCE_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: managed },
        'linux'
      ).configPath
    ).toBe(join(agentDir, 'mcp.json'))
    expect(existsSync(managed)).toBe(false)
  })
  it('honors a direct absolute PI_CODING_AGENT_DIR and rejects a relative override', () => {
    const { home, agentDir, env } = fixture()
    expect(
      planPiConfig(join(home, 'unused'), { ...env, PI_CODING_AGENT_DIR: agentDir }, 'linux')
        .configPath
    ).toBe(join(agentDir, 'mcp.json'))
    expect(() => planPiConfig(home, { ...env, PI_CODING_AGENT_DIR: 'relative' }, 'linux')).toThrow(
      'absolute'
    )
  })
  it.each(['missing', 'filtered', 'disabled', 'pinned'])(
    'rejects %s registration without creating mcp.json',
    (kind) => {
      const { home, agentDir, env } = fixture()
      const registration =
        kind === 'filtered'
          ? { source: 'npm:pi-mcp-adapter', extensions: [] }
          : kind === 'disabled'
            ? { source: 'npm:pi-mcp-adapter', autoload: false }
            : 'npm:pi-mcp-adapter@1.0.0'
      write(
        join(agentDir, 'settings.json'),
        JSON.stringify({ packages: kind === 'missing' ? [] : [registration] })
      )
      expect(() => planPiConfig(home, env, 'linux')).toThrow()
      expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false)
    }
  )
  it('requires a materialized adapter, not only a settings registration', () => {
    const { home, adapterRoot, env } = fixture()
    rmSync(adapterRoot, { recursive: true })
    expect(() => planPiConfig(home, env, 'linux')).toThrow('not installed')
  })
  it('rejects an incompatible Pi AI peer version', () => {
    const { home, aiRoot, env } = fixture()
    write(
      join(aiRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.60.0' })
    )
    expect(() => planPiConfig(home, env, 'linux')).toThrow('incompatible')
  })
  it('requires pi-ai/compat when the installed adapter imports it', () => {
    const { home, aiRoot, env } = fixture()
    write(
      join(aiRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.84.1' })
    )
    expect(() => planPiConfig(home, env, 'linux')).toThrow('pi-ai/compat')
  })
})
