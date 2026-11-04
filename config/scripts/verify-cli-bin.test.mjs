import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdtempSync
} from 'node:fs'
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
function makeProjectWithCli(
  content,
  { mode = 0o755, rootPackageType, writeOutPackageJson = true } = {}
) {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'orca-cli-bin-'))
  roots.push(projectDir)
  const cliPath = path.join(projectDir, 'out', 'cli', 'index.js')
  const outPackageJsonPath = path.join(projectDir, 'out', 'package.json')
  mkdirSync(path.dirname(cliPath), { recursive: true })
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ bin: { orca: './out/cli/index.js' }, type: rootPackageType }),
    'utf8'
  )
  if (writeOutPackageJson) {
    writeFileSync(outPackageJsonPath, JSON.stringify({ type: 'commonjs' }), 'utf8')
  }
  writeFileSync(cliPath, content, 'utf8')
  if (process.platform !== 'win32') {
    chmodSync(cliPath, mode)
  }
  return { projectDir, cliPath, outPackageJsonPath }
}

describe('verifyPackageCliBin', () => {
  it('accepts a non-empty Node entrypoint and can run help through Node', () => {
    const { projectDir, cliPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("help-receipt.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\nif (!process.argv.includes("--help")) process.exit(9)\n'
    )

    expect(verifyPackageCliBin({ projectDir, runHelp: true })).toMatchObject({
      binPath: cliPath
    })
    expect(JSON.parse(readFileSync(path.join(projectDir, 'help-receipt.json'), 'utf8'))).toEqual({
      args: ['--help'],
      cwd: projectDir
    })
  })

  it('rejects an empty package bin target', () => {
    const { projectDir } = makeProjectWithCli('')

    expect(() => verifyPackageCliBin({ projectDir })).toThrow('bin.orca target is empty')
  })

  it('rejects package bin targets without a Node shebang', () => {
    const { projectDir } = makeProjectWithCli('console.log("orca")\n')

    expect(() => verifyPackageCliBin({ projectDir })).toThrow('Node shebang')
  })

  it('writes a CommonJS package boundary for the compiled CLI directory', () => {
    const { projectDir, outPackageJsonPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nexports.ok = true\nif (process.argv.includes("--help")) process.exit(0)\n',
      { rootPackageType: 'module', writeOutPackageJson: false }
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

  it('stamps the build commit the CLI pins official skill installs to', () => {
    const { projectDir, outPackageJsonPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nconsole.log("orca")\n',
      { writeOutPackageJson: false }
    )

    verifyPackageCliBin({ projectDir, fixPackageJson: true, sourceCommit: 'c'.repeat(40) })

    expect(JSON.parse(readFileSync(outPackageJsonPath, 'utf8')).commit).toBe('c'.repeat(40))
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('rejects a CLI package boundary that is not CommonJS', () => {
    const { projectDir, outPackageJsonPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nconsole.log("orca")\n'
    )
    writeFileSync(outPackageJsonPath, JSON.stringify({ type: 'module' }), 'utf8')

    expect(() => verifyPackageCliBin({ projectDir })).toThrow('type=commonjs')
  })

  it.skipIf(process.platform === 'win32')('can repair the POSIX executable bit', () => {
    const { projectDir, cliPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nconsole.log("orca")\n',
      { mode: 0o644 }
    )

    expect(() => verifyPackageCliBin({ projectDir })).toThrow('not executable')
    verifyPackageCliBin({ projectDir, fixExecutable: true })
    expect(statSync(cliPath).mode & 0o111).not.toBe(0)
    expect(readFileSync(cliPath, 'utf8')).toContain('#!/usr/bin/env node')
  })

  it('repairs both the package boundary and POSIX executable bit together', () => {
    const { projectDir, cliPath, outPackageJsonPath } = makeProjectWithCli(
      '#!/usr/bin/env node\nconsole.log("orca")\n',
      { mode: 0o644, writeOutPackageJson: false }
    )

    verifyPackageCliBin({ projectDir, fixExecutable: true, fixPackageJson: true })
    expect(JSON.parse(readFileSync(outPackageJsonPath, 'utf8')).type).toBe('commonjs')
    if (process.platform !== 'win32') {
      expect(statSync(cliPath).mode & 0o111).not.toBe(0)
    }
    rmSync(projectDir, { recursive: true, force: true })
  })
})
