import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markQwenWorkspaceTrusted } from './workspace-trust'

let home: string
let workspace: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-qwen-trust-')))
  workspace = join(home, 'workspaces', 'feature')
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function readJsonc(path: string): unknown {
  return parse(readFileSync(path, 'utf8'))
}

describe('markQwenWorkspaceTrusted', () => {
  it('appends to trustDirectories in a settings.json with comments and keeps them', () => {
    const settingsPath = join(home, '.qwen', 'settings.json')
    writeConfig(
      settingsPath,
      '{\n  // keep me\n  "permissions": { "trustDirectories": ["/a"] }\n}\n'
    )
    markQwenWorkspaceTrusted(workspace, {}, home)
    const text = readFileSync(settingsPath, 'utf8')
    expect(text).toContain('// keep me')
    expect(parse(text)).toEqual({ permissions: { trustDirectories: ['/a', workspace] } })
  })

  it('writes under QWEN_CONFIG_DIR, else under QWEN_CLI_HOME', () => {
    const configDir = join(home, 'custom-config')
    markQwenWorkspaceTrusted(workspace, { QWEN_CONFIG_DIR: configDir }, home)
    expect(readJsonc(join(configDir, 'settings.json'))).toEqual({
      permissions: { trustDirectories: [workspace] }
    })
    const cliHome = join(home, 'cli-home')
    markQwenWorkspaceTrusted(workspace, { QWEN_CLI_HOME: cliHome }, home)
    expect(readJsonc(join(cliHome, '.qwen', 'settings.json'))).toEqual({
      permissions: { trustDirectories: [workspace] }
    })
    expect(existsSync(join(home, '.qwen', 'settings.json'))).toBe(false)
  })

  it('records several worktrees once each and keeps existing hooks', () => {
    const settingsPath = join(home, '.qwen', 'settings.json')
    const hooks = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'orca-hook' }] }] }
    writeConfig(settingsPath, JSON.stringify({ hooks }))
    const worktrees = ['a', 'b', 'c'].map((name) => join(home, 'workspaces', name))
    for (const worktree of [...worktrees, worktrees[0]]) {
      mkdirSync(worktree, { recursive: true })
      markQwenWorkspaceTrusted(worktree, {}, home)
    }
    expect(readJsonc(settingsPath)).toEqual({
      hooks,
      permissions: { trustDirectories: worktrees }
    })
  })

  it('leaves a settings.json it cannot parse untouched', () => {
    const settingsPath = join(home, '.qwen', 'settings.json')
    writeConfig(settingsPath, '{ "permissions": ')
    markQwenWorkspaceTrusted(workspace, {}, home)
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ "permissions": ')
  })
})
