import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  aggregateClaudeHookRemovalStatus,
  aggregateClaudeHookStatusWithConfigDirs,
  getDiscoveredClaudeConfigDirHookStatuses,
  installDiscoveredClaudeConfigDirHooks,
  removeDiscoveredClaudeConfigDirHooks
} from './claude-config-dir-hook-controls'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const isClaudeManagedCommand = createManagedCommandMatcher(CLAUDE_SCRIPT_FILE_NAME)

let tmpHome: string

function seedConfigDir(name: string, marker = 'settings.json', content = '{}'): string {
  const dir = join(tmpHome, name)
  mkdirSync(dir, { recursive: true })
  const markerPath = join(dir, marker)
  writeFileSync(markerPath, content)
  return markerPath
}

function settingsCommands(name: string): string[] {
  const parsed = JSON.parse(readFileSync(join(tmpHome, name, 'settings.json'), 'utf-8')) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>
  }
  return Object.values(parsed.hooks ?? {}).flatMap((definitions) =>
    definitions.flatMap((definition) => (definition.hooks ?? []).map((hook) => hook.command ?? ''))
  )
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-config-dirs-'))
  vi.stubEnv('HOME', tmpHome)
  vi.stubEnv('USERPROFILE', tmpHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('discovered Claude config-dir hook lifecycle', () => {
  it('installs the same managed hooks into every marker-backed config dir', () => {
    seedConfigDir('.claude-grok')
    seedConfigDir('.claude.vertex', '.credentials.json')
    seedConfigDir('.claude-empty', 'unrelated.txt')
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )

    const statuses = installDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })

    expect(statuses.map((status) => status.state)).toEqual(['installed', 'installed'])
    for (const dirName of ['.claude-grok', '.claude.vertex']) {
      const commands = settingsCommands(dirName)
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.every(isClaudeManagedCommand)).toBe(true)
    }
    expect(new Set(settingsCommands('.claude-grok'))).toEqual(
      new Set(settingsCommands('.claude.vertex'))
    )
    expect(existsSync(join(tmpHome, '.claude-empty', 'settings.json'))).toBe(false)
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('removes hooks using live discovery after the original marker disappears', () => {
    const credentialMarker = seedConfigDir('.claude-grok', '.credentials.json')
    installDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })
    unlinkSync(credentialMarker)

    const statuses = removeDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })

    expect(statuses.map((status) => status.state)).toEqual(['not_installed'])
    expect(settingsCommands('.claude-grok').some(isClaudeManagedCommand)).toBe(false)
  })

  it('does not recreate a config dir the user deleted', () => {
    seedConfigDir('.claude-grok')
    installDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })
    rmSync(join(tmpHome, '.claude-grok'), { recursive: true, force: true })

    expect(removeDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })).toEqual([])
    expect(existsSync(join(tmpHome, '.claude-grok'))).toBe(false)
  })

  it('keeps install failures diagnosable without logging private directory names', () => {
    seedConfigDir('.claude-private-name', 'settings.json', 'not json {{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const statuses = installDiscoveredClaudeConfigDirHooks({ homeDir: tmpHome })

    expect(statuses.map((status) => status.state)).toEqual(['error'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0].join(' ')).not.toContain('private-name')
  })

  it('converts service exceptions into per-dir error statuses', () => {
    seedConfigDir('.claude-grok')
    const statuses = getDiscoveredClaudeConfigDirHookStatuses({
      homeDir: tmpHome,
      createService: () => ({
        install: () => {
          throw new Error('install failed')
        },
        remove: () => {
          throw new Error('remove failed')
        },
        getStatus: () => {
          throw new Error('status failed')
        }
      })
    })

    expect(statuses).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'error', detail: 'status failed' })
    ])
  })
})

describe('aggregateClaudeHookStatusWithConfigDirs', () => {
  const primary: AgentHookInstallStatus = {
    agent: 'claude',
    state: 'installed',
    configPath: '/home/dev/.claude/settings.json',
    managedHooksPresent: true,
    detail: null
  }

  it('folds unhealthy discovered dirs into the primary status without exposing names', () => {
    const aggregated = aggregateClaudeHookStatusWithConfigDirs(primary, [
      { ...primary, state: 'not_installed', configPath: '/home/dev/.claude-private-name' }
    ])

    expect(aggregated.state).toBe('partial')
    expect(aggregated.detail).toContain('1 discovered Claude config dir')
    expect(aggregated.detail).not.toContain('private-name')
  })

  it('leaves the primary status unchanged when every discovered dir is healthy', () => {
    expect(aggregateClaudeHookStatusWithConfigDirs(primary, [{ ...primary }])).toEqual(primary)
  })

  it('leaves a disabled primary status unchanged when discovered hooks are absent', () => {
    const disabled = { ...primary, state: 'not_installed' as const, managedHooksPresent: false }
    const absent = { ...disabled, configPath: '/home/dev/.claude-flavor' }

    expect(aggregateClaudeHookStatusWithConfigDirs(disabled, [absent])).toEqual(disabled)
  })

  it('reports a partial removal when a discovered config dir could not be cleaned', () => {
    const removed = { ...primary, state: 'not_installed' as const, managedHooksPresent: false }
    const failed = {
      ...primary,
      state: 'error' as const,
      configPath: '/home/dev/.claude-private-name'
    }

    const aggregated = aggregateClaudeHookRemovalStatus(removed, [failed])

    expect(aggregated.state).toBe('partial')
    expect(aggregated.detail).toContain('1 discovered Claude config dir')
    expect(aggregated.detail).not.toContain('private-name')
  })
})
