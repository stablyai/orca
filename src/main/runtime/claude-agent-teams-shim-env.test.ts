import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

const roots: string[] = []
// Why: several tests force process.platform; without restoring it the next test inherits
// the last one's platform and the suite silently becomes order-dependent.
const realPlatform = process.platform

afterEach(async () => {
  setProcessProp('platform', realPlatform)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('claude agent teams shim env', () => {
  it('writes a private tmux shim that calls the Orca shim command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
    roots.push(root)

    await ensureClaudeAgentTeamsShimDir(root)

    await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux "$@"')
  })

  it('builds native shim env on Windows', async () => {
    setProcessProp('platform', 'win32')
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliPath = join(root, 'orca-dev.cmd')
    await writeFile(cliPath, '@echo off\n', 'utf8')

    let capturedShimBin = ''
    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'native-panes-shim',
      baseEnv: { PATH: root },
      createTeamEnv: (shimDir, shimBin) => {
        capturedShimBin = shimBin
        return {
          PATH: `${shimDir};C:\\Windows\\System32`,
          TMUX: '/tmp/orca/fake,0,0',
          TMUX_PANE: '%1'
        }
      }
    })

    expect(plan).toMatchObject({
      command: "claude --teammate-mode auto 'hello'",
      env: expect.objectContaining({ TMUX_PANE: '%1' }),
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
    })
    expect(capturedShimBin).toBe(cliPath)
  })

  it('honors explicit in-process on Windows', async () => {
    setProcessProp('platform', 'win32')

    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'in-process',
      baseEnv: {},
      createTeamEnv: (shimDir, _shimBin) => ({ PATH: shimDir })
    })

    expect(plan).toMatchObject({
      command: "claude --teammate-mode in-process 'hello'",
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    })
    expect(plan?.envToDelete).toBeUndefined()
  })

  it('prepends the shim dir with a semicolon on Windows', async () => {
    setProcessProp('platform', 'win32')
    let capturedTeamEnv: Record<string, string> = {}
    await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'native-panes-shim',
      baseEnv: { ORCA_AGENT_TEAMS_SHIM_BIN: 'C:\\Shim\\orca.exe' },
      createTeamEnv: (shimDir, _shimBin) => {
        capturedTeamEnv = { PATH: `${shimDir};C:\\Windows\\System32` }
        return capturedTeamEnv
      }
    })

    expect(capturedTeamEnv.PATH).toMatch(/^[^;]+;C:\\Windows\\System32$/)
  })

  it('builds native shim env only for direct Claude commands', async () => {
    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: "echo ok; claude 'hello'",
        mode: 'native-panes-shim',
        baseEnv: {},
        createTeamEnv: () => ({})
      })
    ).resolves.toBeNull()
  })

  it('resolves the dev CLI wrapper for the tmux callback binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    expect(resolveClaudeAgentTeamsShimBin({ PATH: root })).toBe(cliPath)
  })

  describe('windows tmux.exe shim installation', () => {
    const originalPlatform = process.platform
    const originalResourcesPath = process.resourcesPath
    const originalCwd = process.cwd

    // Why: the dev candidate is resolved from cwd, so tests that assert "no shim found"
    // must point cwd somewhere empty or the repo's own .build/tmux.exe satisfies it.
    async function useEmptyCwd(): Promise<void> {
      const emptyCwd = await mkdtemp(join(tmpdir(), 'orca-empty-cwd-'))
      roots.push(emptyCwd)
      setProcessProp('cwd', () => emptyCwd)
    }

    afterEach(() => {
      setProcessProp('platform', originalPlatform)
      setProcessProp('resourcesPath', originalResourcesPath)
      setProcessProp('cwd', originalCwd)
    })

    it('copies the bundled tmux shim into the shim dir', async () => {
      setProcessProp('platform', 'win32')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      // Create a fake bundled tmux source
      const fakeResources = await mkdtemp(join(tmpdir(), 'orca-fake-resources-'))
      roots.push(fakeResources)
      const fakeBundledSource = join(fakeResources, 'bin', 'agent-teams', 'tmux.exe')
      await mkdir(join(fakeResources, 'bin', 'agent-teams'), { recursive: true })
      await writeFile(fakeBundledSource, 'TMUX-EXE-BYTES')
      setProcessProp('resourcesPath', fakeResources)

      await ensureClaudeAgentTeamsShimDir(root)

      await expect(readFile(join(root, 'tmux.exe'), 'utf8')).resolves.toBe('TMUX-EXE-BYTES')
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(readFile(join(root, 'tmux.cmd'), 'utf8')).resolves.toContain('agent-teams-tmux')
    })

    it('tolerates a missing bundled shim', async () => {
      setProcessProp('platform', 'win32')
      setProcessProp('resourcesPath', '/nonexistent/path')
      await useEmptyCwd()
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)

      // Should not throw
      await ensureClaudeAgentTeamsShimDir(root)

      // tmux and tmux.cmd should still exist
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(readFile(join(root, 'tmux.cmd'), 'utf8')).resolves.toContain('agent-teams-tmux')
      // tmux.exe should not exist
      await expect(stat(join(root, 'tmux.exe'))).rejects.toThrow()
    })

    it('falls back to the dev build when the packaged shim is absent', async () => {
      // Why: Electron sets resourcesPath in dev too, so a packaged miss must not stop the
      // lookup or `pnpm run build:windows-shims` would never take effect.
      setProcessProp('platform', 'win32')
      setProcessProp('resourcesPath', '/nonexistent/path')
      const devCwd = await mkdtemp(join(tmpdir(), 'orca-dev-cwd-'))
      roots.push(devCwd)
      await mkdir(join(devCwd, 'native', 'windows-cli-launcher', '.build'), { recursive: true })
      await writeFile(
        join(devCwd, 'native', 'windows-cli-launcher', '.build', 'tmux.exe'),
        'DEV-BUILD-BYTES'
      )
      setProcessProp('cwd', () => devCwd)
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)

      await ensureClaudeAgentTeamsShimDir(root)

      await expect(readFile(join(root, 'tmux.exe'), 'utf8')).resolves.toBe('DEV-BUILD-BYTES')
    })

    it('does not rewrite an unchanged shim', async () => {
      setProcessProp('platform', 'win32')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      // Create a fake bundled tmux source
      const fakeResources = await mkdtemp(join(tmpdir(), 'orca-fake-resources-'))
      roots.push(fakeResources)
      const fakeBundledSource = join(fakeResources, 'bin', 'agent-teams', 'tmux.exe')
      await mkdir(join(fakeResources, 'bin', 'agent-teams'), { recursive: true })
      await writeFile(fakeBundledSource, 'TMUX-EXE-BYTES')
      setProcessProp('resourcesPath', fakeResources)

      // First run
      await ensureClaudeAgentTeamsShimDir(root)
      const firstMtime = (await stat(join(root, 'tmux.exe'))).mtimeMs

      // Advance time slightly and run again
      await new Promise((r) => setTimeout(r, 10))
      await ensureClaudeAgentTeamsShimDir(root)
      const secondMtime = (await stat(join(root, 'tmux.exe'))).mtimeMs

      expect(secondMtime).toBe(firstMtime)
    })

    it('copies nothing on non-Windows', async () => {
      setProcessProp('platform', 'darwin')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)

      await ensureClaudeAgentTeamsShimDir(root)

      // Only tmux should exist
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(stat(join(root, 'tmux.exe'))).rejects.toThrow()
      await expect(stat(join(root, 'tmux.cmd'))).rejects.toThrow()
    })
  })
})
