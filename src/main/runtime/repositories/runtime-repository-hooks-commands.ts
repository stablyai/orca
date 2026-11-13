import { getRepoDialableSshTargetId, isRepoOnCatalogHost } from '../../../shared/execution-host'
import { scopeHooksToRepoKind } from '../../../shared/folder-workspace-hooks'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { readFile } from 'node:fs/promises'
import type { WorkspaceHookOwner } from '../../../shared/workspace-hook-owner'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import {
  getEffectiveHooks,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  loadHooks
} from '../../workspace-hooks/hooks'
import { getEffectiveSetupRunPolicy } from '../../workspace-hooks/effective-hook-config'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { getSetupConfig, getSetupTrustContent } from '../../../shared/orca-hook-setup-config'
import { isENOENT } from '../../ipc/filesystem/access/filesystem-path-containment'
import { isFolderRepo } from '../../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../../shared/workspace-setup/setup-script-imports'
import { joinWorktreeRelativePath } from '../files/paths/runtime-relative-paths'
import { blockedWslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import { hashOrcaHookTrustContent } from '../../workspace-hooks/created-worktree-setup-trust'
import type { SetupHooksCreateSource } from '../../../shared/worktree/setup-hooks-create-source'

type RuntimeRepositoryHooksCommandsDeps<TRepo extends WorkspaceHookOwner> = {
  resolveRepo: (selector: string) => Promise<TRepo>
  readCreateSourceHooks: (
    repo: TRepo,
    source: SetupHooksCreateSource
  ) => Promise<{ hooks: OrcaHooks | null } | undefined>
}

export class RuntimeRepositoryHooksCommands<TRepo extends WorkspaceHookOwner> {
  constructor(private readonly deps: RuntimeRepositoryHooksCommandsDeps<TRepo>) {}

  async getRepoHooks(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    const connectionId = getRepoDialableSshTargetId(repo)
    // Why: an `ssh:` repo is not served here, nor a folder another host owns; neither reports hooks.
    if (connectionId || (isFolderRepo(repo) && !isRepoOnCatalogHost(repo))) {
      return {
        hasHooksFile: false,
        hooks: null,
        setupRunPolicy: getEffectiveSetupRunPolicy(repo),
        source: null
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const hooks = getEffectiveHooks(repo)
    const sharedHooks = scopeHooksToRepoKind(repo, hasFile ? loadHooks(repo.path) : null)
    const setupConfig = getSetupConfig(repo, sharedHooks)
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
          ? hookTrust(getSetupTrustContent(sharedHooks))
          : undefined,
      // As desktop's archive prompt: only a shared orca.yaml script needs trust. null tells clients none is needed; older hosts omit it.
      archiveTrust: archiveTrust(repo, sharedHooks)
    }
  }

  async checkRepoHooks(
    repoSelector: string,
    options: { background?: boolean; createSource?: SetupHooksCreateSource } = {}
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo) && !isRepoOnCatalogHost(repo)) {
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
    if (options.createSource && !options.background) {
      const created = await this.deps.readCreateSourceHooks(repo, options.createSource)
      if (created) {
        return {
          status: 'ok' as const,
          hasHooks: created.hooks !== null,
          hooks: created.hooks,
          mayNeedUpdate: false
        }
      }
    }
    const has = hasHooksFile(repo.path)
    const hooks = scopeHooksToRepoKind(repo, has ? loadHooks(repo.path) : null)
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

function hookTrust(scriptContent: string): { contentHash: string; scriptContent: string } {
  return { contentHash: hashOrcaHookTrustContent(scriptContent), scriptContent }
}

function archiveTrust(
  repo: WorkspaceHookOwner,
  sharedHooks: OrcaHooks | null
): { contentHash: string; scriptContent: string } | null {
  const localArchive = repo.hookSettings?.scripts.archive?.trim()
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(localArchive)
  })
  const sharedArchive = sharedHooks?.scripts.archive?.trim()
  return policy === 'local-only' || !sharedArchive ? null : hookTrust(sharedArchive)
}
