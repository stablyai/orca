// Why: the multi-dir lifecycle must (1) write the SAME managed hooks into
// every discovered flavor config dir, (2) uninstall from exactly the dirs the
// ledger says Orca touched — even when discovery results changed since — and
// (3) never log dir names (privacy: these dirs hold credentials). All against
// a temp HOME; the real ~/.claude* is never touched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  aggregateClaudeHookStatusWithConfigDirs,
  installDiscoveredClaudeConfigDirHooks,
  getLedgeredClaudeConfigDirHookStatuses,
  readClaudeConfigDirLedger,
  removeLedgeredClaudeConfigDirHooks
} from './claude-config-dir-hook-controls'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const isClaudeManagedCommand = createManagedCommandMatcher(CLAUDE_SCRIPT_FILE_NAME)

let tmpHome: string
let ledgerPath: string

function seedConfigDir(name: string, marker = 'settings.json', content = '{}'): string {
  const dir = join(tmpHome, name)
  mkdirSync(dir, { recursive: true })
  const markerPath = join(dir, marker)
  writeFileSync(markerPath, content)
  return markerPath
}

function readSettings(name: string): { hooks?: Record<string, { hooks?: { command?: string }[] }[]> } {
  return JSON.parse(readFileSync(join(tmpHome, name, 'settings.json'), 'utf-8'))
}

function settingsCommands(name: string): string[] {
  const parsed = readSettings(name)
  return Object.values(parsed.hooks ?? {}).flatMap((definitions) =>
    definitions.flatMap((definition) => (definition.hooks ?? []).map((h) => h.command ?? ''))
  )
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-config-dirs-'))
  ledgerPath = join(tmpHome, 'user-data', 'agent-hooks', 'claude-config-dirs.json')
  vi.stubEnv('HOME', tmpHome)
  vi.stubEnv('USERPROFILE', tmpHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('installDiscoveredClaudeConfigDirHooks', () => {
  it('installs the same managed hooks into every discovered dir and records the ledger', () => {
    seedConfigDir('.claude-grok')
    seedConfigDir('.claude.vertex', '.credentials.json')
    seedConfigDir('.claude-empty', 'unrelated.txt') // no marker — not discovered
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )

    const statuses = installDiscoveredClaudeConfigDirHooks({ ledgerPath })

    expect(statuses.map((s) => [s.agent, s.state])).toEqual([
      ['claude', 'installed'],
      ['claude', 'installed']
    ])
    for (const dirName of ['.claude-grok', '.claude.vertex']) {
      const commands = settingsCommands(dirName)
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.every((command) => isClaudeManagedCommand(command))).toBe(true)
    }
    // Both dirs point at the ONE shared script — no per-dir script copies.
    expect(new Set(settingsCommands('.claude-grok'))).toEqual(
      new Set(settingsCommands('.claude.vertex'))
    )
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual(['.claude-grok', '.claude.vertex'])
    // Privacy: no dir names in logs.
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('keeps previously ledgered dirs tracked when discovery no longer returns them', () => {
    const grokMarker = seedConfigDir('.claude-grok')
    installDiscoveredClaudeConfigDirHooks({ ledgerPath })
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual(['.claude-grok'])

    // Marker disappears — the dir (and Orca's managed entries) still exist.
    unlinkSync(grokMarker)
    seedConfigDir('.claude.vertex')
    installDiscoveredClaudeConfigDirHooks({ ledgerPath })

    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual(['.claude-grok', '.claude.vertex'])
  })
})

describe('removeLedgeredClaudeConfigDirHooks', () => {
  it('removes managed entries from exactly the ledgered dirs and clears the ledger', () => {
    const grokMarker = seedConfigDir('.claude-grok')
    seedConfigDir('.claude.vertex')
    installDiscoveredClaudeConfigDirHooks({ ledgerPath })
    // .claude-grok loses its marker AFTER install: discovery would miss it,
    // but the ledger still knows Orca wrote hooks there.
    unlinkSync(grokMarker)
    // An untracked dir must NOT be touched by remove.
    seedConfigDir('.claude-untouched')
    writeFileSync(
      join(tmpHome, '.claude-untouched', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } })
    )

    const statuses = removeLedgeredClaudeConfigDirHooks({ ledgerPath })

    expect(statuses).toHaveLength(2)
    for (const dirName of ['.claude-grok', '.claude.vertex']) {
      expect(settingsCommands(dirName).some((c) => isClaudeManagedCommand(c))).toBe(false)
    }
    expect(settingsCommands('.claude-untouched')).toEqual(['user-hook'])
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual([])
  })

  it('keeps a dir ledgered when its removal fails', () => {
    seedConfigDir('.claude-grok')
    installDiscoveredClaudeConfigDirHooks({ ledgerPath })
    // Unparseable settings.json → remove reports error → dir stays tracked.
    writeFileSync(join(tmpHome, '.claude-grok', 'settings.json'), 'not json {{')

    const statuses = removeLedgeredClaudeConfigDirHooks({ ledgerPath })

    expect(statuses.map((s) => s.state)).toEqual(['error'])
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual(['.claude-grok'])
  })
})

describe('readClaudeConfigDirLedger', () => {
  it('returns empty for a missing or corrupt ledger', () => {
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual([])
    mkdirSync(join(tmpHome, 'user-data', 'agent-hooks'), { recursive: true })
    writeFileSync(ledgerPath, 'not json {{')
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual([])
  })

  it('drops entries that violate the flavor-dir naming convention', () => {
    mkdirSync(join(tmpHome, 'user-data', 'agent-hooks'), { recursive: true })
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        configDirNames: ['.claude', '.openclaude', 'evil', '../escape', '.claude-ok']
      })
    )
    expect(readClaudeConfigDirLedger(ledgerPath)).toEqual(['.claude-ok'])
  })
})

describe('getLedgeredClaudeConfigDirHookStatuses / aggregate', () => {
  it('reports per-dir statuses for ledgered dirs and folds them into the primary status', () => {
    seedConfigDir('.claude-grok')
    seedConfigDir('.claude.vertex')
    installDiscoveredClaudeConfigDirHooks({ ledgerPath })
    // Break one dir: user wipes its hooks.
    writeFileSync(join(tmpHome, '.claude-grok', 'settings.json'), JSON.stringify({ hooks: {} }))

    const statuses = getLedgeredClaudeConfigDirHookStatuses({ ledgerPath })
    expect(statuses.map((s) => s.state).sort()).toEqual(['installed', 'not_installed'])

    const primary: AgentHookInstallStatus = {
      agent: 'claude',
      state: 'installed',
      configPath: join(tmpHome, '.claude', 'settings.json'),
      managedHooksPresent: true,
      detail: null
    }
    const aggregated = aggregateClaudeHookStatusWithConfigDirs(primary, statuses)
    expect(aggregated.state).toBe('partial')
    // Count only — dir names must not leak into status text.
    expect(aggregated.detail).toContain('1 discovered Claude config dir')
    expect(aggregated.detail).not.toContain('grok')

    // All healthy → primary unchanged.
    const healthy = statuses.map((s) => ({ ...s, state: 'installed' as const }))
    expect(aggregateClaudeHookStatusWithConfigDirs(primary, healthy)).toEqual(primary)
  })
})
