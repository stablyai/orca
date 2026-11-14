import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPackageCliBin } from './verify-cli-bin.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Builds a temporary Orca-style project fixture with a compiled CLI entrypoint. */
function makeProjectWithCli(content) {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'orca-cli-bin-'))
  roots.push(projectDir)
  const cliPath = path.join(projectDir, 'out', 'cli', 'index.js')
  const outPackageJsonPath = path.join(projectDir, 'out', 'package.json')
  mkdirSync(path.dirname(cliPath), { recursive: true })
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ bin: { orca: './out/cli/index.js' }, type: 'module' }),
    'utf8'
  )
  writeFileSync(cliPath, content, 'utf8')
  if (process.platform !== 'win32') {
    chmodSync(cliPath, 0o755)
  }
  return { projectDir, outPackageJsonPath }
}

describe('verifyPackageCliBin', () => {
  it('writes a CommonJS package boundary for the compiled CLI directory', () => {
    const { projectDir, outPackageJsonPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nexports.ok = true\nif (process.argv.includes("--help")) process.exit(0)\n'
    )

    expect(() => verifyPackageCliBin({ projectDir, runHelp: true })).toThrow(
      'compiled CLI package boundary is missing'
    )
    verifyPackageCliBin({ projectDir, fixPackageJson: true, runHelp: true })

    expect(JSON.parse(readFileSync(outPackageJsonPath, 'utf8'))).toEqual({
      name: 'orca-compiled-output',
      type: 'commonjs',
      private: true
    })
  })
})
