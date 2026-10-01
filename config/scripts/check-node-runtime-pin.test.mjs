import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  SERVER_TARGETS
} from '../../src/shared/node-runtime-pin.ts'
import {
  findNodeRuntimePinProblems,
  lockfileRootImporter,
  main
} from './check-node-runtime-pin.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const HASH = 'a'.repeat(64)

function validInput() {
  const pin = {
    version: '24.21.0',
    electron: '43.7.5',
    napi: 10,
    headers: { file: 'node-v24.21.0-headers.tar.gz', sha256: HASH },
    windowsImportLibs: { 'win32-x64': { file: 'win-x64/node.lib', sha256: HASH } }
  }
  const targets = ['linux-x64-glibc', 'win32-x64']
  const assets = {
    'linux-x64-glibc': {
      source: 'official',
      archive: 'node-v24.21.0-linux-x64.tar.gz',
      archiveSha256: HASH,
      executableSha256: HASH,
      executableSize: 1
    },
    'win32-x64': {
      source: 'official',
      archive: 'node-v24.21.0-win-x64.zip',
      archiveSha256: HASH,
      executableSha256: HASH,
      executableSize: 1
    }
  }
  return {
    pin,
    assets,
    targets,
    packageJson: { devDependencies: { electron: '43.7.5' }, engines: { node: '24' } },
    rootImporter: {
      devDependencies: {
        electron: { specifier: '43.7.5', version: '43.7.5(supports-color@7.2.0)' }
      }
    }
  }
}

describe('findNodeRuntimePinProblems', () => {
  it('accepts a consistent pin', () => {
    expect(findNodeRuntimePinProblems(validInput())).toEqual([])
  })

  it('rejects an Electron bump that the pin did not follow', () => {
    const input = validInput()
    input.packageJson.devDependencies.electron = '43.8.0'
    input.rootImporter.devDependencies.electron.version = '43.8.0'
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'package.json electron is 43.8.0, but NODE_RUNTIME_PIN.electron is 43.7.5',
      'pnpm-lock.yaml resolves electron 43.8.0, but NODE_RUNTIME_PIN.electron is 43.7.5'
    ])
  })

  it('rejects a lockfile that resolves a different Electron than package.json', () => {
    const input = validInput()
    input.rootImporter.devDependencies.electron.version = '43.7.6'
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'pnpm-lock.yaml resolves electron 43.7.6, but NODE_RUNTIME_PIN.electron is 43.7.5'
    ])
  })

  it('rejects a pin major that differs from engines.node', () => {
    const input = validInput()
    input.packageJson.engines.node = '>=26'
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'NODE_RUNTIME_PIN.version 24.21.0 is not package.json engines.node major 26'
    ])
  })

  it('requires exactly one asset per server target', () => {
    const input = validInput()
    delete input.assets['win32-x64']
    input.assets['freebsd-x64'] = input.assets['linux-x64-glibc']
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'NODE_RUNTIME_ASSETS has no entry for win32-x64',
      'NODE_RUNTIME_ASSETS has freebsd-x64, which is not in SERVER_TARGETS'
    ])
  })

  it('rejects malformed hashes, sizes, sources and stale archive names', () => {
    const input = validInput()
    input.pin.headers.sha256 = 'ABC'
    input.assets['linux-x64-glibc'] = {
      source: 'mirror',
      archive: 'node-v24.20.0-linux-x64.tar.gz',
      archiveSha256: HASH.toUpperCase(),
      executableSha256: `${HASH}0`,
      executableSize: 0
    }
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'NODE_RUNTIME_PIN.headers.sha256 is not a 64-character hex SHA-256',
      'linux-x64-glibc: source must be official or unofficial, got mirror',
      'linux-x64-glibc: archive node-v24.20.0-linux-x64.tar.gz is not node-v24.21.0-linux-x64.tar.gz',
      'linux-x64-glibc: archiveSha256 is not a 64-character hex SHA-256',
      'linux-x64-glibc: executableSha256 is not a 64-character hex SHA-256',
      'linux-x64-glibc: executableSize must be a positive integer'
    ])
  })
  it('rejects a missing or mistargeted Windows node.lib', () => {
    const input = validInput()
    input.pin.windowsImportLibs['win32-x64'] = { file: 'win-arm64/node.lib', sha256: 'x' }
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'NODE_RUNTIME_PIN.windowsImportLibs.win32-x64.file is not win-x64/node.lib',
      'NODE_RUNTIME_PIN.windowsImportLibs.win32-x64.sha256 is not a 64-character hex SHA-256'
    ])
  })
  it('checks the compat table against its own target list', () => {
    const input = validInput()
    input.compatTargets = ['linux-x64-glibc217']
    input.compatAssets = {
      'linux-x64-glibc217': {
        source: 'unofficial',
        archive: 'node-v24.21.0-linux-x64.tar.gz',
        archiveSha256: HASH,
        executableSha256: HASH,
        executableSize: 1
      },
      'linux-x64-glibc': input.assets['linux-x64-glibc']
    }
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'linux-x64-glibc217: archive node-v24.21.0-linux-x64.tar.gz is not node-v24.21.0-linux-x64-glibc-217.tar.gz',
      'NODE_RUNTIME_COMPAT_ASSETS has linux-x64-glibc, which is not in COMPAT_SERVER_TARGETS'
    ])
    delete input.compatAssets['linux-x64-glibc217']
    expect(findNodeRuntimePinProblems(input)).toContain(
      'NODE_RUNTIME_COMPAT_ASSETS has no entry for linux-x64-glibc217'
    )
  })
  it("rejects another target's archive", () => {
    const input = validInput()
    input.assets['win32-x64'].archive = 'node-v24.21.0-win-arm64.zip'
    expect(findNodeRuntimePinProblems(input)).toEqual([
      'win32-x64: archive node-v24.21.0-win-arm64.zip is not node-v24.21.0-win-x64.zip'
    ])
  })
})

describe('lockfileRootImporter', () => {
  it('merges the root importer across pnpm 12 lockfile documents', () => {
    const contents = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    packageManagerDependencies: {}',
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    devDependencies:',
      '      electron:',
      '        specifier: 43.7.5',
      '        version: 43.7.5(supports-color@7.2.0)',
      ''
    ].join('\n')
    expect(lockfileRootImporter(contents).devDependencies.electron.version).toBe(
      '43.7.5(supports-color@7.2.0)'
    )
  })
})

describe('committed pin', () => {
  it('passes the repository check', () => {
    expect(main(projectDir)).toBe(0)
  })

  it('covers every server target', () => {
    expect(Object.keys(NODE_RUNTIME_ASSETS).sort()).toEqual([...SERVER_TARGETS].sort())
    expect(NODE_RUNTIME_PIN.headers.file).toBe(`node-v${NODE_RUNTIME_PIN.version}-headers.tar.gz`)
  })

  it('runs in the static analysis job', () => {
    const workflow = parse(readFileSync(path.join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const commands = workflow.jobs.static_analysis.steps.map((step) => step.run ?? '')
    expect(commands).toContain('pnpm run check:node-runtime-pin')
  })
})
