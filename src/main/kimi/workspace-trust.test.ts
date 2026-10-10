import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWorkspaceTrustOnThisHost } from '../execution-host-workspace-trust'
import { applyRelayAgentWorkspaceTrust } from '../../relay/agent-workspace-trust-spawn'
import { markKimiWorkspaceTrusted } from './workspace-trust'

let root: string
let home: string
let workspace: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-kimi-trust-'))
  home = join(root, 'home')
  workspace = join(home, 'projects', 'Sample Project')
  mkdirSync(workspace, { recursive: true })
  vi.stubEnv('KIMI_CODE_HOME', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function trust(path: string, kimiHome?: string): Promise<void> {
  return applyWorkspaceTrustOnThisHost('kimi', path, () => ({
    homes: [home],
    agentHome: home,
    kimiHome,
    claudeConfig: () => null,
    codexConfigFiles: () => [],
    deadlineMs: 1_500
  }))
}

describe('Kimi workspace trust', () => {
  it('matches a key produced by Kimi Code 2.1.1', () => {
    const kimiHome = join(root, 'key-fixture')
    const windows = process.platform === 'win32'
    markKimiWorkspaceTrusted(
      windows ? 'C:\\projects\\Sample Project' : '/projects/Sample Project',
      kimiHome
    )
    expect(readdirSync(join(kimiHome, 'workspace-trust'))).toEqual([
      windows ? 'wd_sample-project_f415ab4f33c6' : 'wd_sample-project_ca1d0df07991'
    ])
  })

  it('writes an exact-folder record and keeps its original timestamp on repeated launch', async () => {
    await trust(workspace)
    const directory = join(home, '.kimi-code', 'workspace-trust')
    const names = readdirSync(directory)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^wd_sample-project_[a-f0-9]{12}$/)
    const path = join(directory, names[0])
    const original = readFileSync(path, 'utf8')
    expect(JSON.parse(original)).toEqual({ root: workspace, trustedAt: expect.any(Number) })
    await trust(workspace)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('does not pre-trust the home, an ancestor, or a filesystem root', async () => {
    for (const path of [home, root, parse(root).root]) {
      await trust(path)
    }
    expect(existsSync(join(home, '.kimi-code'))).toBe(false)
  })

  it('honors a custom runtime home on the executing relay', async () => {
    const kimiHome = join(root, 'custom-kimi')
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'kimi',
      { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome },
      { wslShell: false }
    )
    expect(readdirSync(join(kimiHome, 'workspace-trust'))).toHaveLength(1)
    expect(existsSync(join(home, '.kimi-code'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'shares the record across Windows path case variants',
    () => {
      const kimiHome = join(root, 'custom-kimi')
      markKimiWorkspaceTrusted(workspace, kimiHome)
      markKimiWorkspaceTrusted(workspace.toUpperCase(), kimiHome)
      expect(readdirSync(join(kimiHome, 'workspace-trust'))).toHaveLength(1)
    }
  )
})
