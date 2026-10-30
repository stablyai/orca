import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import { getEffectiveHooksFromConfig, type EffectiveOrcaHooks } from './effective-hook-config'
import { windowsFsPath } from './wsl/wsl-unc-drive-fs-path'

export function loadRequiredLifecycleHooks(
  repo: Repo,
  hooksRoot: string,
  kind: 'remove' | 'archive' = 'remove'
): EffectiveOrcaHooks | null {
  const settings = repo.hookSettings
  if (
    settings !== undefined &&
    (settings === null ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      !settings.scripts ||
      typeof settings.scripts !== 'object' ||
      Array.isArray(settings.scripts) ||
      ['setup', 'archive', 'remove'].some((key) => {
        const value: unknown = Reflect.get(settings.scripts, key)
        return value !== undefined && typeof value !== 'string'
      }))
  ) {
    throw new Error(
      'Cannot verify lifecycle hook configuration: private script settings are malformed.'
    )
  }
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  if (rawPolicy !== undefined && !['local-only', 'shared-only', 'run-both'].includes(rawPolicy)) {
    throw new Error(
      'Cannot verify lifecycle hook configuration: the private command source policy is invalid. Review repository hook settings and retry.'
    )
  }
  const sourcePolicy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo.hookSettings?.scripts[kind]?.trim())
  })
  if (sourcePolicy === 'local-only') {
    return getEffectiveHooksFromConfig(repo, null)
  }
  let content: string
  try {
    content = readFileSync(windowsFsPath(join(hooksRoot, 'orca.yaml')), 'utf-8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return getEffectiveHooksFromConfig(repo, null)
    }
    throw new Error(
      'Cannot verify lifecycle hook configuration: orca.yaml could not be read. Fix its access and retry.'
    )
  }
  return getEffectiveHooksFromConfig(
    repo,
    parseOrcaYaml(content, { strictRemoval: kind === 'remove', strictArchive: kind === 'archive' })
  )
}
