import { getRepoDialableSshTargetId } from '../../shared/execution-host'
import { createHash } from 'node:crypto'
import { windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'
import { readFile } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import { getEffectiveHooks, hasHooksFile, hasUnrecognizedOrcaYamlKeys, loadHooks } from '../hooks'
import { getEffectiveSetupRunPolicy } from '../effective-hook-config'
import { getSetupConfig, getSetupTrustContent } from '../../shared/orca-hook-setup-config'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'

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
    const setupConfig = isFolderRepo(repo) ? null : getSetupConfig(repo, sharedHooks)
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy: getEffectiveSetupRunPolicy(repo),
      source: hasFile ? ('orca.yaml' as const) : hooks ? ('legacy' as const) : null,
      // Why: `hooks` drops defaultTabs, so clients gate the setup choice on this instead.
      setupConfig,
      // Local-only setup runs the user's own script, which needs no orca.yaml trust.
      setupTrust:
        setupConfig && setupConfig.source !== 'local'
          ? setupTrust(getSetupTrustContent(sharedHooks))
          : undefined
    }
  }

  async checkRepoHooks(repoSelector: string, options: { background?: boolean } = {}) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { status: 'ok' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    const connectionId = getRepoDialableSshTargetId(repo)
    if (connectionId) {
      return { status: 'error' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    // As the desktop's hooks:check: a render-driven check must not open a stopped distro's UNC paths.
    const blocked = options.background ? await blockedWslDistroForPath(repo.path) : null
    if (blocked) {
      return {
        status: 'error' as const,
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false,
        unavailable:
          blocked.state === 'stopped'
            ? ('wsl-distro-stopped' as const)
            : ('wsl-distro-unverifiable' as const)
      }
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
    // A stopped distro's `\\wsl.localhost` paths would boot it for a background inspection (E9).
    if (isFolderRepo(repo) || (await blockedWslDistroForPath(repo.path))) {
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

function setupTrust(scriptContent: string): { contentHash: string; scriptContent: string } {
  return { contentHash: createHash('sha256').update(scriptContent).digest('hex'), scriptContent }
}
