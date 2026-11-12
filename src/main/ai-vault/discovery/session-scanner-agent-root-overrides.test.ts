import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanOptions } from '../session-scanner-types'

/** Exercise root consumers: module-time constants can bypass an otherwise correct override validator (#13082). */

const NO_OPTIONS: AiVaultScanOptions = {}
const NO_WSL: readonly string[] = []

async function rootDirsFor(
  agent: 'codex' | 'copilot' | 'devin' | 'openclaw' | 'kimi' | 'grok',
  env: Record<string, string>
): Promise<string[]> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value)
  }
  const sources = await import('./session-scanner-agent-sources.js')
  const source = sources.AI_VAULT_AGENT_SOURCES[agent]
  if (!source) {
    throw new Error(`no source table entry for ${agent}`)
  }
  return source.rootDirs(NO_OPTIONS, NO_WSL)
}

describe('agent scan roots from environment overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('finds Devin transcripts in a relocated platform data directory', async () => {
    const dataDir = join(homedir(), 'relocated-agent-data')
    const roots = await rootDirsFor('devin', {
      DEVIN_HOME: '',
      [process.platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME']: dataDir
    })
    expect(roots).toEqual(
      ['transcripts', 'agent_logs'].map((dir) => join(dataDir, 'devin', 'cli', dir))
    )
  })

  it('keeps an explicit transcript root isolated and discovers both WSL layouts', async () => {
    const { AI_VAULT_AGENT_SOURCES } = await import('./session-scanner-agent-sources')
    const custom = join(homedir(), 'custom-devin')
    const wslHome = join(homedir(), 'wsl-home')
    expect(
      AI_VAULT_AGENT_SOURCES.devin?.rootDirs({ devinTranscriptsDir: custom }, [wslHome])
    ).toEqual([
      custom,
      join(wslHome, '.local', 'share', 'devin', 'cli', 'transcripts'),
      join(wslHome, '.local', 'share', 'devin', 'cli', 'agent_logs')
    ])
  })
})
