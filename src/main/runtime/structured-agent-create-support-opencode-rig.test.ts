import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { resolveHostStructuredAgentCreateSupport } from './structured-agent-launch-support'

// Live QA run 5 on #25845: the app launched with HOME and every XDG directory pointed into the rig,
// and OpenCode's Command and per-agent PATH both naming a private 1.18.31. The host's whole create
// check, with a real `--version` against stand-in scripts, must admit that OpenCode.

const { loginShell } = vi.hoisted(() => {
  const loginShell: { env: Record<string, string> } = { env: {} }
  return { loginShell }
})
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => loginShell.env
}))

let root: string
let privateOpencode: string

/** A stand-in `opencode` that answers `--version` with `version`; never a real agent CLI. */
async function fakeOpencode(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'opencode')
  await writeFile(file, `#!/bin/sh\necho ${version}\n`)
  await chmod(file, 0o755)
  return file
}

function rigSettings(command: string, extraEnv: Record<string, string> = {}) {
  return {
    nativeChatInheritShellEnvironment: true,
    nativeChatShellEnvironmentVariables: [],
    agentCmdOverrides: { opencode: command },
    agentDefaultEnv: {
      opencode: { PATH: `${join(root, 'oc-prefix', 'bin')}:/usr/bin:/bin`, ...extraEnv }
    }
  }
}

const managedAccounts = {
  list: () => ({ accounts: [], activeAccountId: null }),
  restoreOriginalEnvironment: restoreManagedDataAccountEnvironment,
  environmentForAccount: () => ({})
}

/** OpenCode's account binding, as create resolves it: the account a new chat would pin. */
function pinnedAccount(launchEnv: Record<string, string>) {
  return openCodeAcpAccountBinding(() => managedAccounts).resolve({ launchEnv })
}

/** `agentSession.createSupport` on this host for a local git worktree under the rig's settings. */
function createSupport(settings: ReturnType<typeof rigSettings>) {
  return resolveHostStructuredAgentCreateSupport({
    agent: 'opencode',
    worktreeSelector: 'id:workspace-1',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    runtime: {
      requireStore: () => ({ getSettings: () => settings }),
      resolveRuntimeFileTarget: async () => ({ worktree: { path: join(root, 'proj') } })
    }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-opencode-rig-'))
  await mkdir(join(root, 'proj'))
  const homebrew = await fakeOpencode(join(root, 'homebrew'), '2.0.21')
  privateOpencode = await fakeOpencode(join(root, 'oc-prefix', 'bin'), '1.18.31')
  const home = join(root, 'home-r7')
  loginShell.env = {
    PATH: `${join(homebrew, '..')}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache')
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('OpenCode create support under the QA rig', () => {
  it('admits the private 1.18.31 the Command setting names, with every XDG directory set', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(await createSupport(rigSettings(privateOpencode))).toEqual({ supported: true })
    expect(info).toHaveBeenCalledWith(
      `[agent-cli-version] ${privateOpencode} --version: 1.18.31 is supported`
    )
  })

  it('admits the 2.x first on the shell PATH when the Command names it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const homebrew = join(root, 'homebrew', 'opencode')

    expect(await createSupport(rigSettings(homebrew))).toEqual({ supported: true })
  })

  it('names the check that refused an older Command in the main log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const older = await fakeOpencode(join(root, 'older'), '1.18.30')

    expect(await createSupport(rigSettings(older))).toEqual({
      supported: false,
      reason: 'agent'
    })
    expect(warn).toHaveBeenCalledWith(
      '[structured-create-support] opencode unsupported: installed-agent check refused (reason agent)'
    )
  })

  it('admits inline credentials and relative folders, recording no folders for the chat', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const settings = rigSettings(privateOpencode, {
      OPENCODE_AUTH_CONTENT: '{}',
      XDG_DATA_HOME: 'relative/data',
      XDG_STATE_HOME: 'relative/state'
    })

    expect(await createSupport(settings)).toEqual({ supported: true })
    await expect(pinnedAccount(settings.agentDefaultEnv.opencode)).resolves.toEqual({
      kind: 'opencode',
      locator: { kind: 'unmanaged' }
    })
  })
})
