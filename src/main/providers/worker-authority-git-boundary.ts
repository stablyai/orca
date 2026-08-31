import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_GIT_CONFIG_BYTES = 1024 * 1024

export function resolveWorkerAuthorityGitMetadataPaths(workspacePath: string): string[] {
  const dotGitPath = join(workspacePath, '.git')
  let stat
  try {
    stat = lstatSync(dotGitPath)
  } catch {
    throw new Error('worker_authority_isolation_failed')
  }
  if (stat.isDirectory()) {
    return [realpathSync(dotGitPath)]
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error('worker_authority_isolation_failed')
  }
  const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(dotGitPath, 'utf8'))
  if (!match?.[1]) {
    throw new Error('worker_authority_isolation_failed')
  }
  const gitDir = realpathSync(resolve(workspacePath, match[1]))
  const commonDirMarker = join(gitDir, 'commondir')
  let commonDir = gitDir
  try {
    const commonDirValue = readFileSync(commonDirMarker, 'utf8').trim()
    if (commonDirValue) {
      commonDir = realpathSync(resolve(gitDir, commonDirValue))
    }
  } catch {
    commonDir = gitDir
  }
  return [...new Set([realpathSync(dotGitPath), gitDir, commonDir])]
}

export function resolveWorkerAuthorityGitConfigPaths(gitMetadataPaths: string[]): string[] {
  const configs: string[] = []
  for (const metadataPath of gitMetadataPaths) {
    if (!lstatSync(metadataPath).isDirectory()) {
      continue
    }
    for (const name of ['config', 'config.worktree']) {
      const path = join(metadataPath, name)
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GIT_CONFIG_BYTES) {
          throw new Error('worker_authority_isolation_failed')
        }
        configs.push(realpathSync(path))
      } catch (error) {
        if (error instanceof Error && error.message === 'worker_authority_isolation_failed') {
          throw error
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('worker_authority_isolation_failed')
        }
      }
    }
  }
  return [...new Set(configs)]
}

export function assertNoCredentialBearingGitRemote(gitMetadataPaths: string[]): void {
  const commonDir = gitMetadataPaths.at(-1)
  if (!commonDir) {
    return
  }
  const configPath = join(commonDir, 'config')
  let config: string
  try {
    const stat = lstatSync(configPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GIT_CONFIG_BYTES) {
      throw new Error('worker_authority_isolation_failed')
    }
    config = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message === 'worker_authority_isolation_failed') {
      throw error
    }
    return
  }
  for (const match of config.matchAll(/^\s*url\s*=\s*(\S+)\s*$/gim)) {
    try {
      const url = new URL(match[1] as string)
      if (url.username || url.password) {
        throw new Error('worker_authority_isolation_failed')
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'worker_authority_isolation_failed') {
        throw error
      }
    }
  }
}
