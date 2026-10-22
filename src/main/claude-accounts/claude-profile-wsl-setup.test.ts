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
import type * as os from 'node:os'
import type * as ClaudeVersions from '../claude/claude-hook-event-versions'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => vi.fn())
const guestHome = vi.hoisted(() => vi.fn())
const version = vi.hoisted(() => vi.fn())
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: guestHome
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: capture }))
vi.mock('../claude/claude-hook-event-versions', async (original) => ({
  ...(await original<typeof ClaudeVersions>()),
  probeClaudeCliVersion: version
}))
import { ClaudeHookService } from '../claude/hook-service'
import { getManagedScriptPath, removeManagedHooks } from '../claude/hook-settings'
import { provisionWslClaudeAccountProfile } from './claude-profile-wsl-setup'

it.skipIf(process.platform === 'win32').each(['unset', 'explicit-default', 'custom'])(
  'copies WSL settings and global state with a %s guest override',
  async (override) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-profile-root-')))
    try {
      const userHome = join(root, 'home')
      guestHome.mockReturnValue(userHome)
      const custom = override === 'custom' ? join(root, 'custom') : join(userHome, '.claude')
      mkdirSync(userHome)
      mkdirSync(custom)
      writeFileSync(join(custom, 'settings.json'), '{"model":"opus"}')
      writeFileSync(
        join(userHome, '.claude.json'),
        '{"hasCompletedOnboarding":true,"theme":"light"}'
      )
      writeFileSync(join(custom, '.claude.json'), '{"hasCompletedOnboarding":true,"theme":"dark"}')
      capture.mockResolvedValue(override === 'unset' ? {} : { CLAUDE_CONFIG_DIR: custom })
      version.mockClear()
      const report = await provisionWslClaudeAccountProfile(userHome, 'Ubuntu', 'test', false)
      expect(report.outcome).toBe('prepared')
      expect(report.surfaces.hooks).toBe('absent')
      expect(version).not.toHaveBeenCalled()
      expect(
        JSON.parse(
          readFileSync(
            join(userHome, '.local/share/orca/claude-profiles/test/home/settings.json'),
            'utf8'
          )
        )
      ).toEqual({ model: 'opus' })
      expect(
        JSON.parse(
          readFileSync(
            join(userHome, '.local/share/orca/claude-profiles/test/home/.claude.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        hasCompletedOnboarding: true,
        theme: override === 'unset' ? 'light' : 'dark'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'reconciles working profile hooks after a hookless custom-source upgrade, before global installation and on unchanged refresh',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-profile-upgrade-')))
    try {
      const userHome = join(root, 'home')
      guestHome.mockReturnValue(userHome)
      const conventional = join(userHome, '.claude')
      const custom = join(root, 'custom')
      mkdirSync(conventional, { recursive: true })
      mkdirSync(custom)
      const service = new ClaudeHookService()
      const claudeVersion = '2.1.261'
      version.mockResolvedValue(claudeVersion)
      writeFileSync(join(conventional, 'settings.json'), '{"model":"sonnet"}')
      service.install({
        claudeVersion,
        target: { kind: 'system-default', configDir: conventional }
      })
      capture.mockResolvedValue({})
      await provisionWslClaudeAccountProfile(userHome, 'Ubuntu', 'test', false)
      const profile = join(userHome, '.local/share/orca/claude-profiles/test/home')
      const settings = join(profile, 'settings.json')
      const login = '{"oauthAccount":{"emailAddress":"profile@example.test"}}'
      writeFileSync(join(profile, '.claude.json'), login)
      expect(existsSync(join(profile, '..', 'profile.json'))).toBe(true)
      expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toBeDefined()
      const original = readFileSync(join(conventional, 'settings.json'), 'utf8')
      const userHook = { hooks: [{ type: 'command', command: 'notify-me' }] }
      const source = {
        model: 'opus',
        permissions: { allow: ['Read'] },
        hooks: { Stop: [userHook] },
        statusLine: { type: 'command', command: 'my-status' }
      }
      writeFileSync(join(custom, 'settings.json'), JSON.stringify(source))
      capture.mockResolvedValue({ HOME: userHome, PATH: '/guest/bin', CLAUDE_CONFIG_DIR: custom })
      const setup = () => provisionWslClaudeAccountProfile(userHome, 'Ubuntu', 'test', true)
      const upgraded = await setup()
      const copied = JSON.parse(readFileSync(settings, 'utf8'))
      expect(copied.hooks.StopFailure).toBeDefined()
      expect(upgraded).toMatchObject({
        outcome: 'prepared',
        warnings: [],
        surfaces: { hooks: 'merged' }
      })
      expect(removeManagedHooks(copied, 'claude-hook.sh').config).toEqual(source)
      expect(copied.hooks.Stop).toContainEqual(userHook)
      expect(readFileSync(join(profile, '.claude.json'), 'utf8')).toBe(login)
      expect(readFileSync(join(conventional, 'settings.json'), 'utf8')).toBe(original)
      expect(JSON.parse(readFileSync(join(custom, 'settings.json'), 'utf8'))).toEqual(source)
      expect(getManagedScriptPath()).toContain(join(userHome, '.orca', 'agent-hooks'))
      expect(existsSync(getManagedScriptPath())).toBe(true)
      expect(version).toHaveBeenLastCalledWith(expect.any(String), {
        cwd: userHome,
        env: { HOME: userHome, PATH: '/guest/bin', CLAUDE_CONFIG_DIR: custom }
      })
      // A hook-only difference must be repaired even though provisioning skips the copy.
      writeFileSync(settings, JSON.stringify(removeManagedHooks(copied, 'claude-hook.sh').config))
      service.install({ claudeVersion, target: { kind: 'system-default', configDir: custom } })
      const refreshed = await setup()
      expect(refreshed.surfaces).toMatchObject({ 'settings.json': 'unchanged', hooks: 'merged' })
      expect(JSON.parse(readFileSync(settings, 'utf8')).hooks).toEqual(copied.hooks)
      expect(readFileSync(join(profile, '.claude.json'), 'utf8')).toBe(login)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
