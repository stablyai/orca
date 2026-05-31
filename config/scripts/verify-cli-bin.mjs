#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyPackageCliBin({
  projectDir = path.resolve(import.meta.dirname, '..', '..'),
  fixExecutable = false,
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

  return { binPath, size: statSync(binPath).size }
}

function main() {
  const args = new Set(process.argv.slice(2))
  const result = verifyPackageCliBin({
    fixExecutable: args.has('--fix-executable'),
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
