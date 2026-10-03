import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// assetmap.json carries absolute file-system paths; maps only restate the bundle.
const UNHASHED_OUTPUT = /(^|\/)assetmap\.json$|\.map$/

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Only the shell switch reaches the bundle: any other EXPO_PUBLIC_* in the caller's env is inlined too. */
export function exportEnvironment(baseEnv, variant) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => !name.startsWith('EXPO_PUBLIC_'))
  )
  if (variant === 'ota') {
    env.EXPO_PUBLIC_MOBILE_SHELL = 'ota'
  }
  return env
}

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative]
  })
}

export function hashExportOutput(outputDir) {
  const lines = listFiles(outputDir)
    .filter((file) => !UNHASHED_OUTPUT.test(file))
    .sort()
    .map((file) => `${file}\t${sha256(fs.readFileSync(path.join(outputDir, file)))}`)
  return sha256(lines.join('\n'))
}

/**
 * Metro source paths are project-rooted (`/src/x`, `/../src/shared/x`); make them repo-relative
 * and drop pnpm's peer-hashed store directory so a dependency bump reads as changed files.
 */
export function repoPathOfBundleSource(source) {
  const bare = source.replace(/^\0/, '')
  if (!bare.startsWith('/')) {
    return `virtual:${bare}`
  }
  return path.posix
    .normalize(`mobile${bare}`)
    .replace(/^mobile\/node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'mobile/node_modules/')
}

/** Expo Router's route-context module requires absolute paths; strip the checkout's repo root. */
export function moduleDigestsFromSourceMap(sourceMap, projectDir) {
  const repoRoot = `${path.dirname(projectDir)}${path.sep}`
  const digestsByPath = new Map()
  sourceMap.sources.forEach((source, index) => {
    const raw = sourceMap.sourcesContent?.[index]
    const content = typeof raw === 'string' ? raw.split(repoRoot).join('<repo>/') : raw
    const key = repoPathOfBundleSource(source)
    const digests = digestsByPath.get(key) ?? []
    digests.push(typeof content === 'string' ? sha256(content) : 'no-content')
    digestsByPath.set(key, digests)
  })
  const modules = {}
  for (const key of [...digestsByPath.keys()].sort()) {
    const digests = digestsByPath.get(key).sort()
    // Two installed versions of one package collapse to one key; hash them together.
    modules[key] = digests.length === 1 ? digests[0] : sha256(digests.join('\n'))
  }
  return modules
}

function readSourceMaps(outputDir) {
  return listFiles(outputDir)
    .filter((file) => file.endsWith('.js.map'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8')))
}

export function exportShellBundle(projectDir, variant, platform, outputDir) {
  const cli = path.join(projectDir, 'node_modules', 'expo', 'bin', 'cli')
  const args = [cli, 'export', '--platform', platform, '--output-dir', outputDir]
  // Hermes bytecode is excluded: hermesc is pinned by react-native, which the native side hashes.
  args.push('--no-bytecode', '--source-maps', '--dump-assetmap')
  const result = spawnSync(process.execPath, args, {
    cwd: projectDir,
    env: exportEnvironment(process.env, variant),
    stdio: ['ignore', 2, 2]
  })
  if (result.status !== 0) {
    throw new Error(
      `expo export ${variant}/${platform} exited with ${result.status ?? result.signal}`
    )
  }
  const modules = Object.assign(
    {},
    ...readSourceMaps(outputDir).map((map) => moduleDigestsFromSourceMap(map, projectDir))
  )
  return { hash: hashExportOutput(outputDir), modules }
}
