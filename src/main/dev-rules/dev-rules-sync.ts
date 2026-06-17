import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { DevRule, Repo, WorktreeMeta } from '../../shared/types'
import { computeEffectiveDevRules } from '../../shared/dev-rules'
import {
  hasManagedDevRulesBlock,
  removeManagedBlock,
  renderDevRulesBlock,
  upsertManagedBlock
} from '../../shared/managed-agent-rules-block'
import type { IFilesystemProvider } from '../providers/types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { isWslPath, parseWslPath, toWindowsWslPath } from '../wsl'

// Native instruction files every supported CLI agent reads on launch.
const AGENT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

export type DevRulesFileWritePlan =
  | { action: 'write'; content: string }
  | { action: 'delete' }
  | { action: 'none' }

/** Pure decision: given a file's current content (or null when absent) and the
 *  rendered block (''=no rules), decide whether to write, delete, or do nothing.
 *  - No rules + file has no managed block → leave the file untouched.
 *  - No rules + file is only the managed block → delete it (don't strand an
 *    empty file we created).
 *  - Idempotent: returns 'none' when the result equals the current content. */
export function planDevRulesFileWrite(
  existing: string | null,
  block: string
): DevRulesFileWritePlan {
  if (block.length === 0) {
    if (existing === null || !hasManagedDevRulesBlock(existing)) {
      return { action: 'none' }
    }
    const stripped = removeManagedBlock(existing)
    if (stripped.length === 0) {
      return { action: 'delete' }
    }
    return existing === stripped ? { action: 'none' } : { action: 'write', content: stripped }
  }
  const next = upsertManagedBlock(existing, block)
  return existing === next ? { action: 'none' } : { action: 'write', content: next }
}

// Filesystem port — the only part that differs between local and remote repos.
export type DevRulesFilePort = {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

export async function applyDevRulesToFile(
  port: DevRulesFilePort,
  filePath: string,
  block: string
): Promise<void> {
  const existing = await port.read(filePath)
  const plan = planDevRulesFileWrite(existing, block)
  if (plan.action === 'write') {
    await port.write(filePath, plan.content)
  } else if (plan.action === 'delete') {
    await port.remove(filePath)
  }
}

// WSL worktrees run on a Linux filesystem while writeFileSync runs on Windows;
// translate the Linux path to a Windows UNC path so the write lands correctly.
function resolveLocalAgentFilePath(worktreePath: string, fileName: string): string {
  const joined = joinWorktreeRelativePath(worktreePath, fileName)
  if (isWslPath(worktreePath)) {
    const wslInfo = parseWslPath(worktreePath)
    if (wslInfo) {
      return toWindowsWslPath(joined.trim(), wslInfo.distro)
    }
  }
  return joined
}

function createLocalDevRulesPort(): DevRulesFilePort {
  return {
    async read(filePath) {
      try {
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
      } catch {
        return null
      }
    },
    async write(filePath, content) {
      writeFileSync(filePath, content, 'utf-8')
    },
    async remove(filePath) {
      try {
        unlinkSync(filePath)
      } catch {
        // Already gone — nothing to remove.
      }
    }
  }
}

function createRemoteDevRulesPort(provider: IFilesystemProvider): DevRulesFilePort {
  return {
    async read(filePath) {
      try {
        const result = await provider.readFile(filePath)
        // Binary file → treat as "no managed content"; never corrupt it.
        return result.isBinary ? null : result.content
      } catch {
        return null
      }
    },
    async write(filePath, content) {
      await provider.writeFile(filePath, content)
    },
    async remove(filePath) {
      try {
        await provider.deletePath(filePath)
      } catch {
        // Already gone — nothing to remove.
      }
    }
  }
}

export type DevRulesWorktreeTarget = { repo: Repo; worktreePath: string }

/** Build the list of existing worktrees to re-sync dev rules into. Worktree meta
 *  is keyed `${repo.id}::${path}`; archived worktrees are skipped. Pure so it can
 *  be unit-tested without a store. */
export function collectDevRulesWorktreeTargets(
  repos: Repo[],
  allMeta: Record<string, WorktreeMeta>
): DevRulesWorktreeTarget[] {
  const targets: DevRulesWorktreeTarget[] = []
  for (const repo of repos) {
    const prefix = `${repo.id}::`
    for (const [key, meta] of Object.entries(allMeta)) {
      if (!key.startsWith(prefix) || meta.isArchived) {
        continue
      }
      const worktreePath = key.slice(prefix.length)
      if (worktreePath) {
        targets.push({ repo, worktreePath })
      }
    }
  }
  return targets
}

/** Re-apply dev rules to every existing worktree. User-initiated; idempotent. */
export async function applyDevRulesToExistingWorktrees(params: {
  repos: Repo[]
  allMeta: Record<string, WorktreeMeta>
  rules: DevRule[]
}): Promise<{ applied: number }> {
  const targets = collectDevRulesWorktreeTargets(params.repos, params.allMeta)
  for (const target of targets) {
    await writeDevRulesBlockForWorktree({
      repo: target.repo,
      worktreePath: target.worktreePath,
      rules: params.rules
    })
  }
  return { applied: targets.length }
}

/** Render the repo's effective enabled dev rules into the worktree's AGENTS.md
 *  and CLAUDE.md (non-destructive managed block). Works for local and SSH/remote
 *  repos. Never throws — a worktree that exists on disk must not be reported as a
 *  failed create just because rules could not be written. */
export async function writeDevRulesBlockForWorktree(params: {
  repo: Repo
  worktreePath: string
  rules: DevRule[]
  fsProvider?: IFilesystemProvider
}): Promise<void> {
  const { repo, worktreePath, rules } = params
  try {
    const block = renderDevRulesBlock(computeEffectiveDevRules(rules, repo.id))

    let port: DevRulesFilePort
    let resolvePath: (fileName: string) => string
    if (repo.connectionId) {
      const provider = params.fsProvider ?? getSshFilesystemProvider(repo.connectionId)
      if (!provider) {
        // Connection dropped mid-create — skip silently, like remote setup does.
        return
      }
      port = createRemoteDevRulesPort(provider)
      resolvePath = (fileName) => joinWorktreeRelativePath(worktreePath, fileName)
    } else {
      port = createLocalDevRulesPort()
      resolvePath = (fileName) => resolveLocalAgentFilePath(worktreePath, fileName)
    }

    for (const fileName of AGENT_INSTRUCTION_FILES) {
      await applyDevRulesToFile(port, resolvePath(fileName), block)
    }
  } catch (error) {
    console.error(`[dev-rules] Failed to write dev rules for ${worktreePath}:`, error)
  }
}
