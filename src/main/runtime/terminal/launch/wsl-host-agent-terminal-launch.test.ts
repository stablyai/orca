import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import './runtime-agent-terminal-startup'
import { resolveWslHostAgentLaunchInputs } from './wsl-host-agent-terminal-launch'

let root: string
let windowsMount: string
let windowsBin: string
let nativeBin: string
let home: string

function fakeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  return file
}

function inputsFor(agent: TuiAgent, opts: { override?: string; isRemote?: boolean } = {}) {
  return resolveAgentStartupPlanInputs({
    agent,
    settings: opts.override ? { agentCmdOverrides: { [agent]: opts.override } } : {},
    platform: 'linux',
    isRemote: opts.isRemote ?? false,
    shell: 'posix'
  })
}

function launch(agent: TuiAgent, pathEnv: string, opts: Parameters<typeof inputsFor>[1] = {}) {
  return resolveWslHostAgentLaunchInputs(inputsFor(agent, opts), pathEnv, {
    isWslHost: true,
    mounts: [windowsMount],
    homePath: home
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsl-host-agent-launch-'))
  windowsMount = join(root, 'mnt', 'c')
  windowsBin = join(windowsMount, 'Users', 'u', 'AppData', 'Roaming', 'npm')
  nativeBin = join(root, 'usr', 'local', 'bin')
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// POSIX paths and exec bits stand in for a distro; Windows runners can't model them.
describe.skipIf(process.platform === 'win32')('resolveWslHostAgentLaunchInputs', () => {
  it('launches the distro copy by absolute path even when a Windows copy is on PATH first', () => {
    fakeExecutable(windowsBin, 'claude')
    const native = fakeExecutable(nativeBin, 'claude')
    const inputs = launch('claude', `${windowsBin}:${nativeBin}`)
    expect(inputs.cmdOverrides.claude).toBe(`'${native}'`)
  })

  // orcad's PATH lacks the interactive shell's nvm/~/.local entries; the install-dir search still finds them.
  it('finds a distro install that only the interactive shell PATH would list', () => {
    fakeExecutable(windowsBin, 'codex')
    const nvm = fakeExecutable(join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin'), 'codex')
    expect(launch('codex', `/usr/bin:${windowsBin}`).cmdOverrides.codex).toBe(`'${nvm}'`)
    rmSync(join(home, '.nvm'), { recursive: true })
    const local = fakeExecutable(join(home, '.local', 'bin'), 'codex')
    expect(launch('codex', `/usr/bin:${windowsBin}`).cmdOverrides.codex).toBe(`'${local}'`)
  })
})
