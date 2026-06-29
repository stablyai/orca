#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT_COMMONJS_PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'orca-compiled-output',
    type: 'commonjs',
    private: true
  },
  null,
  2
)}\n`

/**
 * Verifies the published CLI entrypoint and the module-type boundary for the
 * compiled output tree that the packaged CLI loads at runtime.
 */
export function verifyPackageCliBin({
  projectDir = path.resolve(import.meta.dirname, '..', '..'),
  fixExecutable = false,
  fixPackageJson = false,
  runHelp = false
} = {}) {
  const packageJsonPath = path.join(projectDir, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const binTarget = packageJson.bin?.orca
  if (typeof binTarget !== 'string' || binTarget.length === 0) {
    throw new Error('package.json must declare bin.orca')
  }

  const binPath = path.resolve(projectDir, binTarget)
  const stats = statSync(binPath)
  if (!stats.isFile()) {
    throw new Error(`bin.orca target is not a file: ${binTarget}`)
  }
  if (stats.size === 0) {
    throw new Error(`bin.orca target is empty: ${binTarget}`)
  }

  const content = readFileSync(binPath, 'utf8')
  if (!content.startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`bin.orca target must start with a Node shebang: ${binTarget}`)
  }

  const outPackageJsonPath = path.join(projectDir, 'out', 'package.json')
  if (fixPackageJson) {
    mkdirSync(path.dirname(outPackageJsonPath), { recursive: true })
    writeFileSync(outPackageJsonPath, OUT_COMMONJS_PACKAGE_JSON, 'utf8')
  }
  let outPackageJson
  try {
    outPackageJson = JSON.parse(readFileSync(outPackageJsonPath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `compiled CLI package boundary is missing: ${path.relative(projectDir, outPackageJsonPath)}`
      )
    }
    throw error
  }
  if (outPackageJson.type !== 'commonjs') {
    throw new Error(
      `compiled CLI package boundary must declare type=commonjs: ${path.relative(
        projectDir,
        outPackageJsonPath
      )}`
    )
  }

  if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) {
    if (!fixExecutable) {
      throw new Error(`bin.orca target is not executable: ${binTarget}`)
    }
    chmodSync(binPath, stats.mode | 0o755)
  }

  if (runHelp) {
    execFileSync(process.execPath, [binPath, '--help'], {
      cwd: projectDir,
      stdio: 'ignore'
    })
  }

  return { binPath, outPackageJsonPath, size: statSync(binPath).size }
}

/** Runs CLI verification from npm scripts and local release checks. */
function main() {
  const args = new Set(process.argv.slice(2))
  const result = verifyPackageCliBin({
    fixExecutable: args.has('--fix-executable'),
    fixPackageJson: args.has('--fix-package-json'),
    runHelp: args.has('--run-help')
  })
  console.log(
    `[cli-bin] verified ${path.relative(process.cwd(), result.binPath)} (${result.size} bytes)`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
