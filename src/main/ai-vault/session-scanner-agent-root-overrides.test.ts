import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanOptions } from './session-scanner-types'

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

const RELATIVE_VALUES = ['.', '..', 'rel/path', '~/sessions', 'C:foo', 'C:'] as const

const CASES = [
  {
    agent: 'codex',
    envVar: 'CODEX_HOME',
    absolute: '/srv/codex',
    absoluteRoot: join('/srv/codex', 'sessions'),
    defaultRoot: () => join(homedir(), '.codex', 'sessions')
  },
  {
    agent: 'copilot',
    envVar: 'COPILOT_HOME',
    absolute: '/srv/copilot',
    absoluteRoot: join('/srv/copilot', 'session-state'),
    defaultRoot: () => join(homedir(), '.copilot', 'session-state')
  },
  {
    agent: 'devin',
    envVar: 'DEVIN_HOME',
    absolute: '/srv/devin',
    absoluteRoot: join('/srv/devin', 'transcripts'),
    defaultRoot: () =>
      join(
        process.platform === 'win32'
          ? join(
              process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'),
              'devin',
              'cli'
            )
          : join(
              process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
              'devin',
              'cli'
            ),
        'transcripts'
      )
  },
  {
    agent: 'openclaw',
    envVar: 'OPENCLAW_STATE_DIR',
    absolute: '/srv/openclaw',
    absoluteRoot: join('/srv/openclaw', 'agents'),
    defaultRoot: () => join(homedir(), '.openclaw', 'agents')
  },
  {
    agent: 'kimi',
    envVar: 'KIMI_CODE_HOME',
    absolute: '/srv/kimi',
    absoluteRoot: join('/srv/kimi', 'sessions'),
    defaultRoot: () => join(homedir(), '.kimi-code', 'sessions')
  },
  {
    agent: 'grok',
    envVar: 'GROK_HOME',
    absolute: '/srv/grok',
    absoluteRoot: join('/srv/grok', 'sessions'),
    defaultRoot: () => join(homedir(), '.grok', 'sessions')
  }
] as const

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

  it('finds Devin transcripts when the platform data variable is empty', async () => {
    const roots = await rootDirsFor('devin', {
      DEVIN_HOME: '',
      APPDATA: '',
      XDG_DATA_HOME: ''
    })
    const dataDir =
      process.platform === 'win32'
        ? join(homedir(), 'AppData', 'Roaming')
        : join(homedir(), '.local', 'share')
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

  for (const testCase of CASES) {
    describe(testCase.envVar, () => {
      it('uses an absolute override', async () => {
        const roots = await rootDirsFor(testCase.agent, {
          [testCase.envVar]: testCase.absolute
        })
        expect(roots[0]).toBe(testCase.absoluteRoot)
      })

      it('tolerates whitespace around an absolute override', async () => {
        const roots = await rootDirsFor(testCase.agent, {
          [testCase.envVar]: `  ${testCase.absolute}  `
        })
        expect(roots[0]).toBe(testCase.absoluteRoot)
      })

      it.each(RELATIVE_VALUES)('falls back to the default root for %j', async (value) => {
        const roots = await rootDirsFor(testCase.agent, {
          [testCase.envVar]: value
        })
        expect(roots[0]).toBe(testCase.defaultRoot())
      })
    })
  }
})
