import { sep } from 'path'
import type { Store } from '../persistence'
import { gitExecFileAsync, gitSpawn, wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import { resolveAuthorizedPath } from './filesystem-auth'
import { checkRgAvailable } from './rg-availability'
import {
  buildExcludePathPrefixes,
  buildGitLsFilesArgsForQuickOpen,
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  type RgOutputMode
} from '../../shared/quick-open-filter'
import { buildQuickOpenBasenameGlob } from '../../shared/quick-open-unique-basename'
import { resolveBasenameFromProcessPasses } from './filesystem-basename-process-runner'

const BASENAME_RESOLUTION_TIMEOUT_MS = 10_000

type LocalGitOptions = { wslDistro?: string }

function getQuickOpenRgOutputMode(
  rawLine: string,
  translatedLine: string,
  rootPath: string
): RgOutputMode {
  if (
    translatedLine !== rawLine ||
    rawLine.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(rawLine) ||
    rawLine.startsWith('\\\\')
  ) {
    return { kind: 'absolute', rootPath }
  }
  return { kind: 'cwd-relative' }
}

async function isInsideGitWorktree(
  rootPath: string,
  localGitOptions: LocalGitOptions
): Promise<boolean> {
  try {
    const result = await gitExecFileAsync(['rev-parse', '--is-inside-work-tree'], {
      cwd: rootPath,
      timeout: 5_000,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
    return result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

function resolveWithGit(
  rootPath: string,
  basename: string,
  basenameGlob: string,
  excludePathPrefixes: readonly string[],
  localGitOptions: LocalGitOptions
): Promise<string | null> {
  const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes, [
    `:(glob)${basenameGlob}`
  ])
  return resolveBasenameFromProcessPasses(basename, excludePathPrefixes, {
    delimiter: '\0',
    passArgs: [primary, ignoredPass],
    timeoutMs: BASENAME_RESOLUTION_TIMEOUT_MS,
    spawnPass: (args) =>
      gitSpawn(args, {
        cwd: rootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      }),
    parsePath: (rawPath) => rawPath,
    // Why: this mirrors Quick Open's git fallback tolerance; non-git roots can
    // produce a fatal code, which should behave like "no unique file" here.
    acceptsExit: () => true
  })
}

function resolveWithRg(
  rootPath: string,
  basename: string,
  basenameGlob: string,
  excludePathPrefixes: readonly string[],
  localGitOptions: LocalGitOptions
): Promise<string | null> {
  const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? localGitOptions.wslDistro
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    includeGlobs: [basenameGlob],
    excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })

  return resolveBasenameFromProcessPasses(basename, excludePathPrefixes, {
    delimiter: '\n',
    passArgs: [primary, ignoredPass],
    timeoutMs: BASENAME_RESOLUTION_TIMEOUT_MS,
    spawnPass: (args) =>
      wslAwareSpawn('rg', args, {
        cwd: rootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      }),
    parsePath: (rawPath) => {
      const translated =
        wslDistroForOutput && rawPath.startsWith('/')
          ? toWindowsWslPath(rawPath, wslDistroForOutput)
          : rawPath
      return normalizeQuickOpenRgLine(
        translated,
        getQuickOpenRgOutputMode(rawPath, translated, rootPath)
      )
    },
    acceptsExit: (code, parseablePathCount) =>
      code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)
  })
}

export async function resolveQuickOpenFileByBasename(
  rootPath: string,
  basename: string,
  store: Store,
  excludePaths?: string[]
): Promise<string | null> {
  const basenameGlob = buildQuickOpenBasenameGlob(basename)
  if (!basenameGlob) {
    return null
  }

  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, excludePaths)

  if (await isInsideGitWorktree(authorizedRootPath, localGitOptions)) {
    try {
      return await resolveWithGit(
        authorizedRootPath,
        basename,
        basenameGlob,
        excludePathPrefixes,
        localGitOptions
      )
    } catch {
      // Fall through to rg when git is unavailable despite rev-parse succeeding.
    }
  }

  const rgAvailable = await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro)
  if (rgAvailable) {
    return resolveWithRg(
      authorizedRootPath,
      basename,
      basenameGlob,
      excludePathPrefixes,
      localGitOptions
    )
  }

  return resolveWithGit(
    authorizedRootPath,
    basename,
    basenameGlob,
    excludePathPrefixes,
    localGitOptions
  )
}
