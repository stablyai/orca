import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanOptions } from './session-scanner-types'

/**
 * The six env-derived scan roots must ignore a non-absolute value (#13082).
 *
 * These assert at the *call sites*, not on the shared helper: four of the roots are module-level
 * consts evaluated at import time, so a helper that exists but is no longer wired into one of them
 * is exactly the regression a helper-only test cannot see.
 */

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

// Every shape a relative value can take, including the two Windows drive-relative ones.
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
    defaultRoot: () => join(homedir(), '.local', 'share', 'devin', 'cli', 'transcripts')
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

  for (const testCase of CASES) {
    describe(testCase.envVar, () => {
      it('uses an absolute override', async () => {
        const roots = await rootDirsFor(testCase.agent, { [testCase.envVar]: testCase.absolute })
        expect(roots[0]).toBe(testCase.absoluteRoot)
      })

      it('tolerates whitespace around an absolute override', async () => {
        const roots = await rootDirsFor(testCase.agent, {
          [testCase.envVar]: `  ${testCase.absolute}  `
        })

        expect(roots[0]).toBe(testCase.absoluteRoot)
      })

      it.each(RELATIVE_VALUES)('falls back to the default root for %j', async (value) => {
        const roots = await rootDirsFor(testCase.agent, { [testCase.envVar]: value })
        expect(roots[0]).toBe(testCase.defaultRoot())
      })

      // A relative root is the actual #13082 failure: it resolves against whichever Orca process
      // reads it, so the walk starts somewhere arbitrary and has no depth, entry or time cap.
      it.each(RELATIVE_VALUES)('never yields a relative root for %j', async (value) => {
        const roots = await rootDirsFor(testCase.agent, { [testCase.envVar]: value })

        for (const root of roots) {
          expect(root).toBe(join(root))
          expect(root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root)).toBe(true)
        }
      })
    })
  }
})
