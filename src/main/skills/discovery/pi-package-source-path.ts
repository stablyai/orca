import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  nativeSkillPathSemantics,
  normalizedSkillPath,
  skillPathInside,
  skillPathsEqual
} from '../../../shared/skills/paths/skill-path-containment'

export type PiPackageScope = 'user' | 'project'

function normalizedAbsoluteDir(value: string | undefined, homeDir: string): string | null {
  const raw = value?.trim()
  if (!raw || raw.includes('\0')) {
    return null
  }
  const candidate =
    raw === '~'
      ? homeDir
      : raw.startsWith('~/') || raw.startsWith('~\\')
        ? join(homeDir, raw.slice(2))
        : raw
  if (!isAbsolute(candidate)) {
    return null
  }
  return resolve(candidate)
}

export function resolvePiAgentDir(
  args: {
    homeDir?: string
    env?: NodeJS.ProcessEnv
  } = {}
): string {
  const env = args.env ?? process.env
  const homeDir = args.homeDir ?? homedir()

  const sourceDir = normalizedAbsoluteDir(env.ORCA_PI_SOURCE_AGENT_DIR, homeDir)
  if (sourceDir) {
    return sourceDir
  }

  const publicDir = normalizedAbsoluteDir(env.PI_CODING_AGENT_DIR, homeDir)
  const ownOverlayDir = normalizedAbsoluteDir(env.ORCA_PI_CODING_AGENT_DIR, homeDir)
  const otherOverlayDir = normalizedAbsoluteDir(env.ORCA_OMP_CODING_AGENT_DIR, homeDir)
  // Ignore Orca's own managed overlay when resolving the user's real Pi agent dir.
  const semantics = nativeSkillPathSemantics()
  if (
    publicDir &&
    (!ownOverlayDir || !skillPathsEqual(publicDir, ownOverlayDir, semantics)) &&
    (!otherOverlayDir || !skillPathsEqual(publicDir, otherOverlayDir, semantics))
  ) {
    return publicDir
  }

  return join(homeDir, '.pi', 'agent')
}

export function isPathWithinPackageRoot(root: string, candidate: string): boolean {
  const semantics = nativeSkillPathSemantics()
  return skillPathsEqual(root, candidate, semantics) || skillPathInside(root, candidate, semantics)
}

function hasUnsafePathPart(value: string, allowSlash: boolean): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return true
  }
  for (const candidate of [value, decoded]) {
    if (candidate.includes('\0') || candidate.includes('\\') || candidate.startsWith('/')) {
      return true
    }
    if (!allowSlash && candidate.includes('/')) {
      return true
    }
    if (candidate.split('/').includes('..')) {
      return true
    }
  }
  return false
}

function parseNpmPackageName(spec: string): string | null {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)
  const name = (match?.[1] ?? spec).trim()
  if (!name || hasUnsafePathPart(name, true)) {
    return null
  }
  return name
}

function parseGitHostAndPath(source: string): { host: string; repoPath: string } | null {
  const hasGitPrefix = source.startsWith('git:')
  const raw = hasGitPrefix ? source.slice('git:'.length).trim() : source.trim()
  if (!raw) {
    return null
  }
  let host = ''
  let repoPath = ''

  const scpMatch = raw.match(/^git@([^:]+):(.+)$/)
  if (scpMatch) {
    host = scpMatch[1] ?? ''
    repoPath = scpMatch[2] ?? ''
  } else if (raw.includes('://')) {
    try {
      const parsed = new URL(raw)
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
        return null
      }
      host = parsed.hostname
      repoPath = parsed.pathname.replace(/^\/+/, '')
    } catch {
      return null
    }
  } else if (hasGitPrefix) {
    const slashIndex = raw.indexOf('/')
    if (slashIndex <= 0) {
      return null
    }
    host = raw.slice(0, slashIndex)
    repoPath = raw.slice(slashIndex + 1)
  } else {
    return null
  }

  const refIndex = repoPath.search(/[@#]/)
  const pathWithoutRef = refIndex > 0 ? repoPath.slice(0, refIndex) : repoPath
  const normalizedPath = pathWithoutRef
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!host || !normalizedPath || normalizedPath.split('/').length < 2) {
    return null
  }
  if (hasUnsafePathPart(host, false) || hasUnsafePathPart(normalizedPath, true)) {
    return null
  }
  return { host, repoPath: normalizedPath }
}

function isLocalPackagePath(source: string): boolean {
  return (
    source === '.' ||
    source === '..' ||
    source === '~' ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~/') ||
    source.startsWith('~\\') ||
    source.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(source)
  )
}

export function resolvePiPackageRoot(args: {
  source: string
  scope: PiPackageScope
  piAgentDir: string
  homeDir: string
  cwd?: string
}): { packageKey: string; packageRoot: string; labelName: string } | null {
  const { source, scope, piAgentDir, homeDir, cwd } = args

  if (source.startsWith('npm:')) {
    const packageName = parseNpmPackageName(source.slice('npm:'.length).trim())
    if (!packageName) {
      return null
    }
    const installRoot =
      scope === 'project' && cwd
        ? join(cwd, '.pi', 'npm', 'node_modules')
        : join(piAgentDir, 'npm', 'node_modules')
    const packageRoot = resolve(installRoot, ...packageName.split('/'))
    if (!skillPathInside(installRoot, packageRoot, nativeSkillPathSemantics())) {
      return null
    }
    return { packageKey: `npm:${packageName}`, packageRoot, labelName: packageName }
  }

  if (source.startsWith('file://')) {
    let localPath: string
    try {
      localPath = fileURLToPath(source)
    } catch {
      return null
    }
    const packageRoot = resolve(localPath)
    return {
      packageKey: `local:${normalizedSkillPath(packageRoot, nativeSkillPathSemantics())}`,
      packageRoot,
      labelName: basename(packageRoot) || source
    }
  }

  if (isLocalPackagePath(source)) {
    const expanded =
      source === '~'
        ? homeDir
        : source.startsWith('~/') || source.startsWith('~\\')
          ? join(homeDir, source.slice(2))
          : source
    const baseDir = scope === 'project' && cwd ? join(cwd, '.pi') : piAgentDir
    const packageRoot = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded)
    return {
      packageKey: `local:${normalizedSkillPath(packageRoot, nativeSkillPathSemantics())}`,
      packageRoot,
      labelName: basename(packageRoot) || source
    }
  }

  const gitInfo = parseGitHostAndPath(source)
  if (gitInfo) {
    const installRoot =
      scope === 'project' && cwd ? join(cwd, '.pi', 'git') : join(piAgentDir, 'git')
    const packageRoot = resolve(installRoot, gitInfo.host, ...gitInfo.repoPath.split('/'))
    if (!skillPathInside(installRoot, packageRoot, nativeSkillPathSemantics())) {
      return null
    }
    return {
      packageKey: `git:${gitInfo.host}/${gitInfo.repoPath}`,
      packageRoot,
      labelName: gitInfo.repoPath
    }
  }

  // Rejected git/URL specs must not fall through to local path resolution.
  if (source.startsWith('git:') || source.startsWith('git@') || source.includes('://')) {
    return null
  }

  const baseDir = scope === 'project' && cwd ? join(cwd, '.pi') : piAgentDir
  const packageRoot = resolve(baseDir, source)
  return {
    packageKey: `local:${normalizedSkillPath(packageRoot, nativeSkillPathSemantics())}`,
    packageRoot,
    labelName: basename(packageRoot) || source
  }
}

export async function inspectPiSkillDir(
  dirPath: string,
  signal?: AbortSignal
): Promise<{ hasSkillFile: boolean; childDirs: string[] }> {
  try {
    signal?.throwIfAborted()
    const entries = await readdir(dirPath, { withFileTypes: true })
    const skillEntry = entries.find((e) => e.name.toLowerCase() === 'skill.md')
    const hasSkillFile = skillEntry
      ? skillEntry.isFile() ||
        (skillEntry.isSymbolicLink() &&
          (await stat(join(dirPath, skillEntry.name)).then(
            (s) => s.isFile(),
            () => false
          )))
      : false
    const dirCandidates = entries.filter((e) => e.name.toLowerCase() !== 'skill.md')
    const childDirs = (
      await Promise.all(
        dirCandidates.map(async (e) => {
          const fullPath = join(dirPath, e.name)
          if (e.isDirectory()) {
            return fullPath
          }
          if (e.isSymbolicLink()) {
            const isDir = await stat(fullPath).then(
              (s) => s.isDirectory(),
              () => false
            )
            return isDir ? fullPath : null
          }
          return null
        })
      )
    ).filter((p): p is string => p !== null)
    return { hasSkillFile, childDirs }
  } catch {
    signal?.throwIfAborted()
    return { hasSkillFile: false, childDirs: [] }
  }
}
