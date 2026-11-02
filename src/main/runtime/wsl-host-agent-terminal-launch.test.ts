import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import {
  resolveWslHostAgentLaunchInputs,
  resolveWslHostAgentResumeInputs
} from './wsl-host-agent-terminal-launch'

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
  it('refuses an agent installed only on the Windows side, and says how to fix it', () => {
    fakeExecutable(windowsBin, 'claude')
    expect(() => launch('claude', `${nativeBin}:${windowsBin}`)).toThrow(
      'claude is installed only on Windows, not in this WSL distro. Install it inside the distro. Or set the claude Command setting to a program inside the distro.'
    )
  })

  it('launches the distro copy by absolute path even when a Windows copy is on PATH first', () => {
    fakeExecutable(windowsBin, 'claude')
    const native = fakeExecutable(nativeBin, 'claude')
    const inputs = launch('claude', `${windowsBin}:${nativeBin}`)
    expect(inputs.cmdOverrides.claude).toBe(`'${native}'`)
  })

  it('launches a native alias instead of refusing for a Windows-only primary name', () => {
    fakeExecutable(windowsBin, 'qodercli')
    const native = fakeExecutable(nativeBin, 'qoder')
    expect(launch('qoder', `${windowsBin}:${nativeBin}`).cmdOverrides.qoder).toBe(`'${native}'`)
  })

  it('refuses Agent Teams when the Claude it runs exists only on Windows', () => {
    fakeExecutable(windowsBin, 'claude')
    expect(() => launch('claude-agent-teams', `${nativeBin}:${windowsBin}`)).toThrow(
      'claude is installed only on Windows, not in this WSL distro. Install it inside the distro. Or set the claude-agent-teams Command setting to a program inside the distro.'
    )
  })

  it('leaves the Agent Teams wrapper command alone when Claude is in the distro', () => {
    fakeExecutable(windowsBin, 'claude')
    fakeExecutable(nativeBin, 'claude')
    const inputs = inputsFor('claude-agent-teams')
    expect(
      resolveWslHostAgentLaunchInputs(inputs, `${windowsBin}:${nativeBin}`, {
        isWslHost: true,
        mounts: [windowsMount],
        homePath: home
      })
    ).toBe(inputs)
  })

  it('refuses an agent whose required companion CLI exists only on Windows', () => {
    fakeExecutable(nativeBin, 'dsh-tui')
    fakeExecutable(windowsBin, 'dsh')
    expect(() => launch('dsh', `${nativeBin}:${windowsBin}`)).toThrow(
      'dsh is installed only on Windows, not in this WSL distro. Install it inside the distro. Or set the dsh Command setting to a program inside the distro.'
    )
  })

  it('keeps launch arguments that ride on the stock command', () => {
    const native = fakeExecutable(nativeBin, 'kiro-cli')
    expect(launch('kiro', nativeBin).cmdOverrides.kiro).toBe(`'${native}' chat --tui`)
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

  it('leaves an agent found nowhere to the shell, as before', () => {
    const inputs = inputsFor('claude')
    expect(
      resolveWslHostAgentLaunchInputs(inputs, nativeBin, {
        isWslHost: true,
        mounts: [windowsMount],
        homePath: home
      })
    ).toBe(inputs)
  })

  it('never checks or rewrites an explicit Command setting', () => {
    fakeExecutable(windowsBin, 'claude')
    const inputs = launch('claude', windowsBin, { override: 'my-claude --flag' })
    expect(inputs.cmdOverrides).toEqual({ claude: 'my-claude --flag' })
  })

  it('leaves remote launches and non-WSL hosts untouched', () => {
    fakeExecutable(windowsBin, 'claude')
    fakeExecutable(nativeBin, 'claude')
    const remote = inputsFor('claude', { isRemote: true })
    expect(
      resolveWslHostAgentLaunchInputs(remote, windowsBin, {
        isWslHost: true,
        mounts: [windowsMount],
        homePath: home
      })
    ).toBe(remote)
    const local = inputsFor('claude')
    expect(
      resolveWslHostAgentLaunchInputs(local, nativeBin, { isWslHost: false, homePath: home })
    ).toBe(local)
  })
})

describe.skipIf(process.platform === 'win32')('resolveWslHostAgentResumeInputs', () => {
  const resume = (agentCommand: string, isWslHost = true) => {
    const args = {
      agent: 'claude' as const,
      cmdOverrides: {},
      platform: 'linux' as const,
      agentCommand
    }
    return {
      args,
      out: resolveWslHostAgentResumeInputs(args, `${windowsBin}:${nativeBin}`, {
        isWslHost,
        mounts: [windowsMount],
        homePath: home
      })
    }
  }

  it('pins a recorded stock command and keeps its arguments', () => {
    const native = fakeExecutable(nativeBin, 'claude')
    expect(resume('claude --verbose').out.agentCommand).toBe(`'${native}' --verbose`)
  })

  it('returns the same arguments off a WSL host or for an already pinned command', () => {
    fakeExecutable(nativeBin, 'claude')
    const offHost = resume('claude', false)
    expect(offHost.out).toBe(offHost.args)
    const pinned = resume(`'${nativeBin}/claude'`)
    expect(pinned.out).toBe(pinned.args)
  })
})

describe.skipIf(process.platform === 'win32')('WSL-host agent terminal launch', () => {
  const original = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    vi.stubEnv('ORCA_WSL_ORCAD_HOST', '1')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
    vi.unstubAllEnvs()
  })

  // Interop stays usable in the agent's terminal (code ., explorer.exe); only the program is pinned.
  it('types the absolute distro path and leaves the terminal PATH alone', async () => {
    const native = fakeExecutable(nativeBin, 'claude')
    vi.stubEnv('PATH', `${nativeBin}:${windowsBin}`)
    const workspace = { id: 'w', path: root, connectionId: null, repo: null, folderWorkspace: null }
    const host = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: for a workspace with no repo or folder, the planner reads only getSettings.
      store: { getSettings: () => ({}) } as never,
      hostIdentity: 'host-1',
      toSessionOptions: () => undefined
    }
    const created = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'claude',
        agentArgs: null,
        launchRuntime: {
          platform: 'linux',
          pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
        }
      },
      host
    )
    expect(created.command).toBe(`'${native}'`)
    expect(created.env?.PATH).toBeUndefined()
  })
})
