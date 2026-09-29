import { execFileSync } from 'node:child_process'
import type * as OsModule from 'node:os'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ homePath: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: () => {
    if (!fixture.homePath) {
      throw new Error('Synthetic hook home is not initialized')
    }
    return fixture.homePath
  }
}))

import { ClaudeHookService } from './hook-service'
import { getManagedScript } from './hook-script'
import { getManagedScript as getCodexScript } from '../codex/codex-hook-script'
import { CLAUDE_HOOK_SETTINGS, OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

describe.skipIf(process.platform === 'win32')('POSIX hook payload persistence', () => {
  it('disables raw fallback for the default Claude and Codex scripts', () => {
    expect(getManagedScript('posix')).not.toContain('>> "$spool_file"')
    expect(getCodexScript('posix')).not.toContain('>> "$spool_file"')
  })

  it('preserves the other Claude-compatible provider source and fallback', () => {
    const script = getManagedScript('posix', { source: 'codebuddy' })
    expect(script).toContain('/hook/codebuddy')
    expect(script).toContain('>> "$spool_file"')
  })

  it.each([
    { agent: 'claude' as const, settings: CLAUDE_HOOK_SETTINGS, persists: false },
    { agent: 'openclaude' as const, settings: OPENCLAUDE_HOOK_SETTINGS, persists: true }
  ])('keeps the $agent policy on install and refresh', async (entry) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hook-policy-'))
    fixture.homePath = dir
    try {
      const service = new ClaudeHookService({
        agent: entry.agent,
        displayName: entry.agent,
        settings: entry.settings
      })
      expect(service.install().state).toBe('installed')
      const scriptPath = join(dir, '.orca', 'agent-hooks', `${entry.settings.scriptBaseName}.sh`)
      const installed = readFileSync(scriptPath, 'utf8')
      expect(installed.includes('>> "$spool_file"')).toBe(entry.persists)
      const configPath = join(dir, entry.settings.configDirName, 'settings.json')
      const configBefore = readFileSync(configPath, 'utf8')

      writeFileSync(scriptPath, getManagedScript('posix', { spoolPersistence: 'full' }))
      await service.refreshManagedScripts()
      expect(readFileSync(scriptPath, 'utf8')).toBe(installed)
      expect(readFileSync(configPath, 'utf8')).toBe(configBefore)
      expect(statSync(scriptPath).mode & 0o777).toBe(0o755)
      await service.refreshManagedScripts()
      expect(readFileSync(scriptPath, 'utf8')).toBe(installed)
    } finally {
      fixture.homePath = ''
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { agent: 'claude', script: () => getManagedScript('posix'), persists: false, output: '{}\n' },
    { agent: 'codex', script: () => getCodexScript('posix'), persists: false, output: '' },
    {
      agent: 'openclaude',
      script: () => getManagedScript('posix', { spoolPersistence: 'full' }),
      persists: true,
      output: '{}\n'
    }
  ])('runs the $agent offline fallback without losing permission output', (entry) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hook-offline-'))
    try {
      const fakeBin = join(dir, 'bin')
      mkdirSync(fakeBin)
      writeFileSync(join(fakeBin, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 })
      const endpoint = join(dir, 'endpoint.fixture')
      writeFileSync(
        endpoint,
        'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=synthetic\nORCA_AGENT_HOOK_ENV=test\nORCA_AGENT_HOOK_VERSION=1\n'
      )
      const scriptPath = join(dir, 'hook.sh')
      writeFileSync(scriptPath, entry.script())
      const payload = { hook_event_name: 'SubagentStop', agent_id: 'synthetic' }
      const output = execFileSync('/bin/sh', [scriptPath], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          ORCA_AGENT_HOOK_ENDPOINT: endpoint,
          ORCA_PANE_KEY: 'synthetic:0',
          ORCA_TAB_ID: 'synthetic',
          ORCA_AGENT_LAUNCH_TOKEN: 'synthetic'
        }
      })
      expect(output).toBe(entry.output)
      expect(readdirSync(dir).includes('spool')).toBe(entry.persists)
      if (entry.persists) {
        const files = readdirSync(join(dir, 'spool'))
        expect(files).toHaveLength(1)
        const record = JSON.parse(readFileSync(join(dir, 'spool', files[0]!), 'utf8').trim())
        expect(record.payload).toEqual(payload)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
