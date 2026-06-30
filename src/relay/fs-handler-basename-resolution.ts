import { execFile, spawn, type ChildProcess } from 'child_process'
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { checkRgAvailable } from './fs-handler-utils'
import { buildRelayCommandEnv } from './relay-command-env'
import {
  buildExcludePathPrefixes,
  buildGitLsFilesArgsForQuickOpen,
  buildRgArgsForQuickOpen
} from '../shared/quick-open-filter'
import {
  HIDDEN_DIR_BLOCKLIST,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath
} from '../shared/quick-open-filter'
import {
  buildQuickOpenBasenameGlob,
  createUniqueQuickOpenBasenameCollector
} from '../shared/quick-open-unique-basename'
import { buildInstallRgMessage } from './fs-handler-install-rg'

const BASENAME_RESOLUTION_TIMEOUT_MS = 10_000
const READDIR_TIMEOUT_MS = 10_000
const READDIR_MAX_VISITED_FILES = 10_000

type ProcessPassConfig = {
  delimiter: '\0' | '\n'
  spawnPass: (args: string[]) => ChildProcess
  passArgs: string[][]
  parsePath: (rawPath: string) => string | null
  timeoutMs: number
  acceptsExit: (code: number | null, parseablePathCount: number) => boolean
}

function shouldDescend(name: string): boolean {
  return name !== 'node_modules' && !HIDDEN_DIR_BLOCKLIST.has(name)
}

function resolveFromProcessPasses(
  basename: string,
  excludePathPrefixes: readonly string[],
  config: ProcessPassConfig
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const collector = createUniqueQuickOpenBasenameCollector(basename, excludePathPrefixes)
    const children: ChildProcess[] = []
    const cleanups: (() => void)[] = []
    let settled = false
    let completedPasses = 0

    const finish = (result: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
      resolve(result)
    }

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
      reject(error)
    }

    for (const args of config.passArgs) {
      const child = config.spawnPass(args)
      children.push(child)
      let buffer = ''
      let done = false
      let parseablePathCount = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        child.stdout?.off('data', handleStdoutData)
        child.stderr?.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
      }
      cleanups.push(cleanup)

      const resolvePass = (): void => {
        if (done || settled) {
          return
        }
        done = true
        cleanup()
        completedPasses += 1
        if (completedPasses === config.passArgs.length) {
          finish(collector.result())
        }
      }

      const rejectPass = (error: Error): void => {
        if (done || settled) {
          return
        }
        done = true
        cleanup()
        fail(error)
      }

      const processPath = (rawPath: string): void => {
        const relativePath = config.parsePath(rawPath)
        if (relativePath === null) {
          return
        }
        parseablePathCount += 1
        if (collector.add(relativePath)) {
          finish(null)
        }
      }

      function handleStdoutData(chunk: string): void {
        buffer += chunk
        let start = 0
        let index = buffer.indexOf(config.delimiter, start)
        while (index !== -1) {
          processPath(buffer.substring(start, index))
          if (settled) {
            return
          }
          start = index + 1
          index = buffer.indexOf(config.delimiter, start)
        }
        buffer = start < buffer.length ? buffer.substring(start) : ''
      }

      function handleStderrData(): void {
        /* drain */
      }

      function handleError(error: Error): void {
        rejectPass(error)
      }

      function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
        if (signal) {
          rejectPass(new Error(`basename scan killed by ${signal}`))
          return
        }
        if (buffer) {
          processPath(buffer)
        }
        if (settled) {
          return
        }
        if (config.acceptsExit(code, parseablePathCount)) {
          resolvePass()
        } else {
          rejectPass(new Error(`basename scan exited with code ${code}`))
        }
      }

      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', handleStdoutData)
      child.stderr?.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
        buffer = ''
        child.kill()
        rejectPass(new Error('basename scan timed out'))
      }, config.timeoutMs)
    }
  })
}

function isInsideGitWorktree(rootPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: rootPath, env: buildRelayCommandEnv() },
      (error, stdout) => resolve(!error && stdout.trim() === 'true')
    )
  })
}

function resolveWithGit(
  rootPath: string,
  basename: string,
  basenameGlob: string,
  excludePathPrefixes: readonly string[]
): Promise<string | null> {
  const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes, [
    `:(glob)${basenameGlob}`
  ])
  return resolveFromProcessPasses(basename, excludePathPrefixes, {
    delimiter: '\0',
    passArgs: [primary, ignoredPass],
    timeoutMs: BASENAME_RESOLUTION_TIMEOUT_MS,
    spawnPass: (args) =>
      spawn('git', ['ls-files', ...args], {
        cwd: rootPath,
        env: buildRelayCommandEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      }),
    parsePath: (rawPath) => rawPath,
    acceptsExit: () => true
  })
}

function resolveWithRg(
  rootPath: string,
  basename: string,
  basenameGlob: string,
  excludePathPrefixes: readonly string[]
): Promise<string | null> {
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    includeGlobs: [basenameGlob],
    excludePathPrefixes,
    forceSlashSeparator: true
  })
  return resolveFromProcessPasses(basename, excludePathPrefixes, {
    delimiter: '\n',
    passArgs: [primary, ignoredPass],
    timeoutMs: BASENAME_RESOLUTION_TIMEOUT_MS,
    spawnPass: (args) =>
      spawn('rg', ['--no-messages', ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      }),
    parsePath: (rawPath) => normalizeQuickOpenRgLine(rawPath, { kind: 'cwd-relative' }),
    acceptsExit: (code, parseablePathCount) =>
      code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)
  })
}

async function resolveWithReaddir(
  rootPath: string,
  basename: string,
  excludePathPrefixes: readonly string[]
): Promise<string | null> {
  const collector = createUniqueQuickOpenBasenameCollector(basename, excludePathPrefixes)
  const deadline = Date.now() + READDIR_TIMEOUT_MS
  let visitedFiles = 0

  async function walk(dirPath: string): Promise<boolean> {
    if (Date.now() > deadline || visitedFiles >= READDIR_MAX_VISITED_FILES) {
      throw new Error(
        visitedFiles >= READDIR_MAX_VISITED_FILES
          ? `File listing exceeded ${READDIR_MAX_VISITED_FILES} files`
          : 'File listing timed out'
      )
    }

    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return false
    }

    for (const entry of entries) {
      const absolutePath = join(dirPath, entry.name)
      const relativePath = relative(rootPath, absolutePath).replace(/\\/g, '/')
      if (shouldExcludeQuickOpenRelPath(relativePath, excludePathPrefixes)) {
        continue
      }
      if (entry.isDirectory()) {
        if (shouldDescend(entry.name) && (await walk(absolutePath))) {
          return true
        }
      } else if (entry.isFile()) {
        visitedFiles += 1
        if (collector.add(relativePath)) {
          return true
        }
      }
    }
    return false
  }

  await walk(rootPath)
  return collector.result()
}

export async function resolveUniqueQuickOpenFileByBasename(
  rootPath: string,
  basename: string,
  excludePaths?: unknown
): Promise<string | null> {
  const basenameGlob = buildQuickOpenBasenameGlob(basename)
  if (!basenameGlob) {
    return null
  }

  const excludePathPrefixes = buildExcludePathPrefixes(rootPath, excludePaths)
  if (await isInsideGitWorktree(rootPath)) {
    try {
      return await resolveWithGit(rootPath, basename, basenameGlob, excludePathPrefixes)
    } catch {
      // Fall through to rg when git unexpectedly fails on a git worktree.
    }
  }

  if (await checkRgAvailable()) {
    return resolveWithRg(rootPath, basename, basenameGlob, excludePathPrefixes)
  }

  try {
    return await resolveWithReaddir(rootPath, basename, excludePathPrefixes)
  } catch (error) {
    throw new Error(await buildInstallRgMessage(error))
  }
}
