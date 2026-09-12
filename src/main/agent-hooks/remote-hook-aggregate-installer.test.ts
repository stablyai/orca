import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { codexHookService } from '../codex/hook-service'
import { droidHookService } from '../droid/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { ampHookService } from '../amp/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { grokHookService } from '../grok/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { devinHookService } from '../devin/hook-service'
import { bobHookService } from '../bob/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'
import { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-controls'
import {
  installRemoteManagedAgentHooks,
  REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
} from './remote-managed-hook-installers'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
}

function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const fs: FakeFs = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map(),
    failRenameTo: new Set()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      if (fs.failRenameTo.has(dst)) {
        cb({ code: 4, message: `rename failed ${dst}` })
        return
      }
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? 0o100644))
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

describe('remote hook aggregate installer', () => {
  // Why: Droid (and Copilot) each shipped a working installRemote but were never
  // registered in REMOTE_MANAGED_HOOK_INSTALLERS, so their status silently never
  // appeared over SSH (issue #7253). Guard the whole bug class, not one agent:
  // every locally-managed hook service that implements installRemote MUST be
  // wired into the remote installer.
  it('registers every managed agent that implements installRemote in the remote installer (issue #7253)', () => {
    const servicesByAgent = new Map<string, { installRemote?: unknown }>([
      ['claude', claudeHookService],
      ['openclaude', openClaudeHookService],
      ['codex', codexHookService],
      ['gemini', geminiHookService],
      ['antigravity', antigravityHookService],
      ['amp', ampHookService],
      ['cursor', cursorHookService],
      ['droid', droidHookService],
      ['command-code', commandCodeHookService],
      ['grok', grokHookService],
      ['copilot', copilotHookService],
      ['hermes', hermesHookService],
      ['devin', devinHookService],
      ['kimi', kimiHookService],
      ['bob', bobHookService]
    ])

    // Guard against a service silently missing from the map above as new agents land.
    for (const [agent] of MANAGED_AGENT_HOOK_INSTALLERS) {
      expect(servicesByAgent.has(agent)).toBe(true)
    }

    const registered = new Set<string>(REMOTE_MANAGED_HOOK_INSTALLER_AGENTS)
    const missing: string[] = []
    for (const [agent, service] of servicesByAgent) {
      if (typeof service.installRemote === 'function' && !registered.has(agent)) {
        missing.push(agent)
      }
    }
    expect(missing).toEqual([])
  })

  it('installs remote Bob hooks into ~/.bob/settings/settings.json, preserving user settings', async () => {
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.bob/settings/settings.json': JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [
            { matcher: 'execute_command', hooks: [{ type: 'command', command: 'echo mine' }] }
          ]
        }
      })
    })

    const status = await bobHookService.installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({ agent: 'bob', state: 'installed' })
    // Why: SSH remotes always get the POSIX script, even when Orca runs on Windows.
    const script = fs.files.get('/home/dev/.orca/agent-hooks/bob-hook.sh')
    expect(script).toMatch(/^#!\/bin\/sh\n/)
    expect(script).toContain('/hook/bob')

    const written = JSON.parse(fs.files.get('/home/dev/.bob/settings/settings.json')!)
    expect(written.theme).toBe('dark')
    expect(written.hooks.PreToolUse).toHaveLength(2)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo mine')
    // Why: Bob validates each entry with a strict schema and drops every global hook on an
    // unknown key, so the remote write must carry exactly type/command/timeout and no matcher.
    const managed = written.hooks.Stop[0]
    expect(Object.keys(managed)).toEqual(['hooks'])
    expect(Object.keys(managed.hooks[0]).sort()).toEqual(['command', 'timeout', 'type'])
    expect(managed.hooks[0].command).toContain('/home/dev/.orca/agent-hooks/bob-hook.sh')
  })

  it('does not overwrite a malformed remote Bob settings.json', async () => {
    const { sftp, fs } = createFakeSftp({ '/home/dev/.bob/settings/settings.json': '{ not json' })

    const status = await bobHookService.installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({ agent: 'bob', state: 'error' })
    expect(fs.files.get('/home/dev/.bob/settings/settings.json')).toBe('{ not json')
  })

  it('installs Droid and Copilot when running the aggregate remote installer (issue #7253)', async () => {
    const { sftp } = createFakeSftp()
    const results = await installRemoteManagedAgentHooks(sftp, '/home/dev', {
      agents: REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
    })
    const byAgent = new Map(results.map((r) => [r.agent, r.state]))
    expect(byAgent.get('droid')).toBe('installed')
    expect(byAgent.get('copilot')).toBe('installed')
  })

  it('installs only positively detected remote agents', async () => {
    const { sftp, fs } = createFakeSftp()

    const results = await installRemoteManagedAgentHooks(sftp, '/home/dev', {
      agents: ['codex']
    })

    expect(results.map((result) => result.agent)).toEqual(['codex'])
    const paths = [...fs.files.keys(), ...fs.dirs]
    for (const unusedHome of ['.factory', '.gemini', '.grok', '.hermes', '.commandcode']) {
      expect(paths.some((path) => path.includes(`/home/dev/${unusedHome}`))).toBe(false)
    }
  })

  it('fails closed when the agent allowlist is omitted or empty (issue #11641)', async () => {
    const { sftp, fs } = createFakeSftp()

    await expect(installRemoteManagedAgentHooks(sftp, '/home/dev')).resolves.toEqual([])
    await expect(
      installRemoteManagedAgentHooks(sftp, '/home/dev', { agents: [] })
    ).resolves.toEqual([])

    // Why: fake SFTP seeds '/' only; no agent config homes or files may appear.
    expect([...fs.files.keys()]).toEqual([])
    expect([...fs.dirs]).toEqual(['/'])
  })

  it('stops before the next installer when its relay request is cancelled', async () => {
    const controller = new AbortController()
    const claudeInstall = vi
      .spyOn(claudeHookService, 'installRemote')
      .mockImplementation(async () => {
        controller.abort()
        return {
          agent: 'claude',
          state: 'installed',
          configPath: '/home/dev/.claude/settings.json',
          managedHooksPresent: true,
          detail: null
        }
      })
    const openClaudeInstall = vi.spyOn(openClaudeHookService, 'installRemote')
    try {
      const { sftp } = createFakeSftp()

      await expect(
        installRemoteManagedAgentHooks(sftp, '/home/dev', {
          signal: controller.signal,
          agents: REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(claudeInstall).toHaveBeenCalledTimes(1)
      expect(openClaudeInstall).not.toHaveBeenCalled()
    } finally {
      claudeInstall.mockRestore()
      openClaudeInstall.mockRestore()
    }
  })
})
