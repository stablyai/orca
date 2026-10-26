import { getRepoDialableSshTargetId } from '../../shared/execution-host'
import { createHash } from 'node:crypto'
import { windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'
import { readFile } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import { getEffectiveHooks, hasHooksFile, hasUnrecognizedOrcaYamlKeys, loadHooks } from '../hooks'
import {
  getDefaultTabCommandTrustContent,
  getEffectiveSetupRunPolicy
} from '../effective-hook-config'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

type RuntimeRepositoryHooksCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
}

export class RuntimeRepositoryHooksCommands {
  constructor(private readonly deps: RuntimeRepositoryHooksCommandsDeps) {}

  async getRepoHooks(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    const connectionId = getRepoDialableSshTargetId(repo)
    // Why: an `ssh:` repo is not served here; it reports no hooks file.
    if (connectionId) {
      return {
        hasHooksFile: false,
        hooks: null,
        setupRunPolicy: getEffectiveSetupRunPolicy(repo),
        source: null
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const hooks = getEffectiveHooks(repo)
    const sharedHooks = hasFile ? loadHooks(repo.path) : null
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy: getEffectiveSetupRunPolicy(repo),
      source: hasFile ? ('orca.yaml' as const) : hooks ? ('legacy' as const) : null,
      setupTrust: setupTrust(repo, getDefaultTabCommandTrustContent(sharedHooks))
    }
  }

  async checkRepoHooks(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { status: 'ok' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    const connectionId = getRepoDialableSshTargetId(repo)
    if (connectionId) {
      return { status: 'error' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      status: 'ok' as const,
      hasHooks: has,
      hooks,
      mayNeedUpdate: has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    }
  }

  async inspectRepoSetupScriptImports(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return []
    }
    return inspectSetupScriptImportCandidates(async (relativePath) => {
      const filePath = windowsFsPath(joinWorktreeRelativePath(repo.path, relativePath))
      if (getRepoDialableSshTargetId(repo)) {
        return null
      }
      try {
        return await readFile(filePath, 'utf-8')
      } catch (error) {
        if (!isENOENT(error)) {
          console.warn('[runtime] Failed to inspect setup script import candidate:', error)
        }
        return null
      }
    })
  }
}

function setupTrust(
  repo: Repo,
  scriptContentValue: string | undefined
): { contentHash: string; scriptContent: string } | undefined {
  const scriptContent = scriptContentValue?.trim()
  if (!scriptContent || repo.hookSettings?.commandSourcePolicy === 'local-only') {
    return undefined
  }
  return { contentHash: createHash('sha256').update(scriptContent).digest('hex'), scriptContent }
}
