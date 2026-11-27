import { access } from 'node:fs/promises'
import { PrioritySemaphore } from '../../shared/concurrency/priority-semaphore'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import { scopeHooksToRepoKind } from '../../shared/folder-workspaces/folder-workspace-hooks'
import { parseOrcaYaml } from '../../shared/workspace-setup/orca-yaml'
import { MAX_ORCA_YAML_BYTES } from '../../shared/workspace-setup/orca-yaml-file-limit'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import { blockedWslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { orcaYamlPath } from './hooks'
import { iterateLfScriptLines } from './setup-runner-script-text'

// Unknown keys suggest a newer config format; let the UI offer an update.
const RECOGNIZED_ORCA_YAML_KEYS = new Set([
  'scripts',
  'setupAgentStartupPolicy',
  'issueCommand',
  'defaultTabs',
  'environmentRecipes',
  'worktree'
])

function hasUnrecognizedOrcaYamlKeys(content: string): boolean {
  for (const line of iterateLfScriptLines(content)) {
    // A bare key: is valid YAML when its block value follows on the next line.
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
    if (match != null && !RECOGNIZED_ORCA_YAML_KEYS.has(match[1])) {
      return true
    }
  }
  return false
}

// Settings checks multiple repos at once. Keep libuv workers free for unrelated I/O.
const hookInspectionSlots = new PrioritySemaphore(2)

export async function inspectWorkspaceHooks(
  repo: Pick<WorkspaceHookOwner, 'path' | 'kind'>,
  background?: boolean
) {
  const release = await hookInspectionSlots.acquire(background ? 1 : 0)
  try {
    // A distro can stop while this inspection waits for a slot.
    const blocked = background ? await blockedWslDistroForPath(repo.path) : null
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
    return { status: 'ok' as const, ...(await readWorkspaceHookConfig(repo)) }
  } finally {
    release()
  }
}

async function readWorkspaceHookConfig(repo: Pick<WorkspaceHookOwner, 'path' | 'kind'>) {
  const yamlPath = orcaYamlPath(repo.path)
  let content: string
  try {
    const { buffer } = await readNodeFileWithinLimit(yamlPath, MAX_ORCA_YAML_BYTES, {
      regularFileOnly: true
    })
    content = buffer.toString('utf-8')
  } catch (error) {
    const hasHooks =
      !isDefinitiveAbsence(error) &&
      (await access(yamlPath).then(
        () => true,
        () => false
      ))
    return { hasHooks, hooks: null, mayNeedUpdate: false }
  }

  const hooks = scopeHooksToRepoKind(repo, parseOrcaYaml(content))
  return {
    hasHooks: true,
    hooks,
    mayNeedUpdate: !hooks && hasUnrecognizedOrcaYamlKeys(content)
  }
}
