import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const root = resolve(import.meta.dirname, '../..')
const PACKAGES = [{ name: '@orca/process-host', dir: 'src/packages/process-host' }]
// Outputs and build scratch space, not inputs.
const NON_INPUTS = new Set(['dist', 'node_modules', '.dist-build.lock'])
const COMPILER_PACKAGES = ['typescript', 'tsx', '@types/node']

function listFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (directory === base && (NON_INPUTS.has(entry.name) || entry.name.startsWith('.dist-'))) {
      return []
    }
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).replaceAll('\\', '/')]
  })
}

/** Sources, manifest, build script, and the exact installed compiler and Node types. */
export function hashPackageInputs(packageDir) {
  const hash = createHash('sha256')
  for (const file of listFiles(packageDir).sort()) {
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(packageDir, file)))
      .update('\0')
  }
  const require = createRequire(join(packageDir, 'package.json'))
  for (const name of COMPILER_PACKAGES) {
    const manifest = realpathSync(require.resolve(`${name}/package.json`))
    hash.update(`${manifest}\0`).update(readFileSync(manifest)).update('\0')
  }
  return hash.digest('hex')
}

/** Size and mtime of every output, so a deleted or edited dist file forces a rebuild. */
function describeOutputs(packageDir) {
  const dist = join(packageDir, 'dist')
  try {
    return listFiles(dist)
      .sort()
      .map((file) => {
        const { size, mtimeMs } = statSync(join(dist, file))
        return `${file}:${size}:${mtimeMs}`
      })
  } catch {
    return []
  }
}

function stampPath(packageDir) {
  return join(packageDir, 'node_modules', '.cache', 'orca-dist-stamp.json')
}

export function isPackageBuildCurrent(packageDir, inputs) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath(packageDir), 'utf8'))
    const outputs = describeOutputs(packageDir)
    return (
      stamp.inputs === inputs &&
      outputs.length > 0 &&
      JSON.stringify(stamp.outputs) === JSON.stringify(outputs)
    )
  } catch {
    return false
  }
}

function writeStamp(packageDir, inputs) {
  const path = stampPath(packageDir)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, JSON.stringify({ inputs, outputs: describeOutputs(packageDir) }))
  renameSync(temporary, path)
}

function runPackageBuild(name) {
  // Why not @orca/process-host: this builds it, so its dist may not exist yet.
  const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
  const result = spawnSync(command, [...prefixArgs, '--filter', name, 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell
  })
  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  for (const { name, dir } of PACKAGES) {
    const packageDir = join(root, dir)
    // Hashed before building: an edit during the build leaves a stale stamp, never a skipped build.
    const inputs = hashPackageInputs(packageDir)
    if (isPackageBuildCurrent(packageDir, inputs)) {
      continue
    }
    const status = runPackageBuild(name)
    if (status !== 0) {
      process.exit(status)
    }
    writeStamp(packageDir, inputs)
  }
}
