import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { resolveCodeWhaleSessionSources } from './session-scanner-codewhale-sources'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import type { AiVaultScanOptions } from './session-scanner-types'

let tempRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function isolatedDiscoveryOptions(
  root: string,
  codeWhaleSessionsDir: string | undefined = join(root, 'codewhale-sessions')
): AiVaultScanOptions {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    opencodeDbPaths: [],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions'),
    codeWhaleSessionsDir
  }
}

describe('CodeWhale AI Vault source discovery', () => {
  it('does not report missing default CodeWhale paths as scan issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-source-discovery-'))
    tempRoots.push(root)
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEWHALE_HOME', join(root, 'missing-codewhale-home'))
    const issues: AiVaultScanIssue[] = []

    const discoveries = await discoverAiVaultSessionSources({
      options: { ...isolatedDiscoveryOptions(root), codeWhaleSessionsDir: undefined },
      limitPerAgent: 10,
      issues
    })

    expect(issues).toEqual([])
    expect(discoveries.some((discovery) => discovery.agent === 'codewhale')).toBe(false)
  })

  it('lets explicit CodeWhale session paths override other local sources', () => {
    const root = join(tmpdir(), 'orca-ai-vault-codewhale-explicit')
    const explicitSessionsDir = join(root, 'explicit-home', 'sessions')
    const envHome = join(root, 'env-home')
    const localHome = join(root, 'local-home')

    expect(
      resolveCodeWhaleSessionSources({ codeWhaleSessionsDir: explicitSessionsDir }, [], {
        codeWhaleHomeEnv: envHome,
        exists: () => true,
        homeDir: localHome
      })
    ).toEqual([
      {
        sessionsDir: explicitSessionsDir,
        codeWhaleHome: dirname(explicitSessionsDir)
      }
    ])
  })

  it('prefers CODEWHALE_HOME over the local default path', () => {
    const root = join(tmpdir(), 'orca-ai-vault-codewhale-env')
    const envHome = join(root, 'env-home')

    expect(
      resolveCodeWhaleSessionSources({}, [], {
        codeWhaleHomeEnv: envHome,
        exists: (path) => path === join(envHome, 'sessions'),
        homeDir: join(root, 'local-home')
      })
    ).toEqual([
      {
        sessionsDir: join(envHome, 'sessions'),
        codeWhaleHome: envHome
      }
    ])
  })

  it('uses only the local CodeWhale sessions directory and skips it when absent', () => {
    const home = join(tmpdir(), 'orca-ai-vault-codewhale-local')
    const primaryHome = join(home, '.codewhale')
    const primarySessionsDir = join(primaryHome, 'sessions')

    expect(
      resolveCodeWhaleSessionSources({}, [], {
        codeWhaleHomeEnv: '',
        exists: (path) => path === primarySessionsDir,
        homeDir: home
      })
    ).toEqual([
      {
        sessionsDir: primarySessionsDir,
        codeWhaleHome: primaryHome
      }
    ])

    expect(
      resolveCodeWhaleSessionSources({}, [], {
        codeWhaleHomeEnv: '',
        exists: () => false,
        homeDir: home
      })
    ).toEqual([])
  })

  it('does not discover legacy DeepSeek session homes for CodeWhale', () => {
    const home = join(tmpdir(), 'orca-ai-vault-codewhale-no-legacy')
    const legacySessionsDir = join(home, '.deepseek', 'sessions')

    expect(
      resolveCodeWhaleSessionSources({}, [], {
        codeWhaleHomeEnv: '',
        exists: (path) => path === legacySessionsDir,
        homeDir: home
      })
    ).toEqual([])
  })

  it('discovers WSL CodeWhale session homes', () => {
    const root = join(tmpdir(), 'orca-ai-vault-codewhale-wsl')
    const localHome = join(root, 'local-home')
    const wslHome = join(root, 'wsl', 'Ubuntu', 'home', 'ada')
    const primaryHome = join(wslHome, '.codewhale')
    const primarySessionsDir = join(primaryHome, 'sessions')

    expect(
      resolveCodeWhaleSessionSources({}, [wslHome], {
        codeWhaleHomeEnv: '',
        exists: (path) => path === primarySessionsDir,
        homeDir: localHome
      })
    ).toEqual([
      {
        sessionsDir: primarySessionsDir,
        codeWhaleHome: primaryHome
      }
    ])
  })
})
