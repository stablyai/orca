import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

async function inspect(path: string) {
  try {
    const stat = await lstat(path, { bigint: true })
    return {
      stat,
      stamp: `${path}:${stat.dev}:${stat.ino}:${stat.mode}${stat.isDirectory() ? '' : `:${stat.size}:${stat.mtimeNs}`}`
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function discover(cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const stamps: string[] = []
  const observe = async (path: string) => {
    const entry = await inspect(path)
    stamps.push(entry?.stamp ?? `${path}:absent`)
    return entry
  }
  const absent = async (path: string) => {
    if (await observe(path)) {
      throw new Error('External or project Codex policy is not eligible for recovery')
    }
  }
  const system =
    process.platform === 'win32'
      ? join(
          Object.entries(environment).find(([key]) => key.toLowerCase() === 'programdata')?.[1] ??
            'C:\\ProgramData',
          'OpenAI',
          'Codex'
        )
      : '/etc/codex'
  for (const file of ['config.toml', 'managed_config.toml', 'requirements.toml']) {
    await absent(join(system, file))
  }
  if (process.platform === 'darwin') {
    await absent('/Library/Managed Preferences/com.openai.codex.plist')
  }
  const canonicalCwd = await realpath(cwd)
  stamps.push(canonicalCwd)
  let root = canonicalCwd
  let marker: Awaited<ReturnType<typeof inspect>> = null
  for (let directory = canonicalCwd; ; directory = dirname(directory)) {
    const found = await observe(join(directory, '.git'))
    if (found) {
      if (found.stat.isSymbolicLink()) {
        throw new Error('Aliased Git marker')
      }
      if (!found.stat.isDirectory() || (await observe(join(directory, '.git', 'HEAD')))) {
        root = directory
        marker = found
        break
      }
    }
    if (dirname(directory) === directory) {
      break
    }
  }
  let sourceRoot = root
  if (marker && !marker.stat.isDirectory()) {
    const markerPath = join(root, '.git')
    const content = (await readFile(markerPath, 'utf8')).trim()
    const match = /^gitdir: (.+)$/.exec(content)
    if (!match) {
      throw new Error('Unattributable Git directory')
    }
    const admin = await realpath(resolve(root, match[1]))
    if (!(await observe(admin))?.stat.isDirectory() || basename(dirname(admin)) !== 'worktrees') {
      throw new Error('Unsupported Git directory layout')
    }
    const readMetadata = async (file: string) => {
      if (!(await observe(join(admin, file)))?.stat.isFile()) {
        throw new Error('Missing worktree registration')
      }
      const value = (await readFile(join(admin, file), 'utf8')).trim()
      stamps.push(value)
      return resolve(admin, value)
    }
    const registeredMarker = await readMetadata('gitdir')
    const common = await realpath(await readMetadata('commondir'))
    if (
      (await realpath(dirname(registeredMarker))) !== root ||
      basename(registeredMarker) !== '.git' ||
      common !== dirname(dirname(admin)) ||
      basename(common) !== '.git'
    ) {
      throw new Error('Worktree registration changed')
    }
    sourceRoot = dirname(common)
    if ((await realpath(join(sourceRoot, '.git'))) !== common) {
      throw new Error('Unattributable root checkout')
    }
  }
  for (let directory = canonicalCwd; ; directory = dirname(directory)) {
    for (const base of new Set([directory, join(sourceRoot, relative(root, directory))])) {
      const configDirectory = join(base, '.codex')
      if ((await inspect(configDirectory))?.stat.isSymbolicLink()) {
        throw new Error('Aliased project policy')
      }
      for (const file of ['config.toml', 'hooks.json', 'rules']) {
        await absent(join(configDirectory, file))
      }
    }
    if (directory === root) {
      break
    }
  }
  return JSON.stringify(stamps)
}

// Discovery walks to the filesystem root, so hot-path checks read a flag refreshed at attempt boundaries.
export function captureCodexProjectConfiguration(cwd: string, environment: NodeJS.ProcessEnv) {
  const snapshot = discover(cwd, environment).catch(() => null)
  let unchanged = true
  return {
    current: () => unchanged,
    revalidate: async (): Promise<boolean> => {
      const initial = await snapshot
      if (initial === null || !unchanged) {
        return false
      }
      const latest = await discover(cwd, environment).catch(() => null)
      unchanged &&= latest === initial
      return unchanged
    }
  }
}
