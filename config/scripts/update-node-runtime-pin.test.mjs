import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPAT_SERVER_TARGETS,
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_COMPAT_ASSETS,
  NODE_RUNTIME_PIN,
  SERVER_TARGETS,
  nodeRuntimeAsset,
  nodeRuntimeExecutablePath
} from '../../src/shared/node-runtime-pin.ts'
import { nodeDistArchiveName } from './node-dist-archive-name.mjs'
import {
  parseNodeApiVersion,
  parseShasums,
  pinWindowsImportLibs,
  renderGeneratedBlock,
  replaceGeneratedBlock,
  selectAssetSource
} from './update-node-runtime-pin.mjs'

const pinFile = path.resolve(import.meta.dirname, '../../src/shared/node-runtime-pin.ts')
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('pinWindowsImportLibs', () => {
  it('reads each Windows node.lib hash from SHASUMS and refuses a missing one', () => {
    const hashes = new Map([
      ['win-x64/node.lib', HASH_A],
      ['win-arm64/node.lib', HASH_B]
    ])
    expect(pinWindowsImportLibs(hashes)).toEqual({
      'win32-arm64': { file: 'win-arm64/node.lib', sha256: HASH_B },
      'win32-x64': { file: 'win-x64/node.lib', sha256: HASH_A }
    })
    hashes.delete('win-arm64/node.lib')
    expect(() => pinWindowsImportLibs(hashes)).toThrow('SHASUMS256.txt lists no win-arm64/node.lib')
  })
})

describe('nodeDistArchiveName', () => {
  it('uses nodejs.org platform names and zip only on Windows', () => {
    expect(nodeDistArchiveName('24.21.0', 'linux-x64-glibc')).toBe('node-v24.21.0-linux-x64.tar.gz')
    expect(nodeDistArchiveName('24.21.0', 'linux-arm64-musl')).toBe(
      'node-v24.21.0-linux-arm64-musl.tar.gz'
    )
    expect(nodeDistArchiveName('24.21.0', 'win32-arm64')).toBe('node-v24.21.0-win-arm64.zip')
  })

  it('names the unofficial glibc 2.17 build for the compat target', () => {
    expect(nodeDistArchiveName('24.21.0', 'linux-x64-glibc217')).toBe(
      'node-v24.21.0-linux-x64-glibc-217.tar.gz'
    )
  })

  it('covers every server and compat target', () => {
    for (const target of [...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS]) {
      expect(nodeDistArchiveName('24.21.0', target)).not.toContain('undefined')
    }
  })
})

describe('nodeRuntimeExecutablePath', () => {
  it('points at bin/node on POSIX and node.exe on Windows', () => {
    expect(nodeRuntimeExecutablePath('darwin-arm64', 'node-v24.21.0-darwin-arm64.tar.gz')).toBe(
      'node-v24.21.0-darwin-arm64/bin/node'
    )
    expect(nodeRuntimeExecutablePath('win32-x64', 'node-v24.21.0-win-x64.zip')).toBe(
      'node-v24.21.0-win-x64/node.exe'
    )
  })
})

describe('parseShasums and selectAssetSource', () => {
  const official = parseShasums(
    `${HASH_A}  node-v24.21.0-linux-x64-musl.tar.gz\nnot a hash line\n${HASH_A}  node-v24.21.0-linux-x64.tar.gz\n`
  )
  const unofficial = parseShasums(
    `${HASH_B}  node-v24.21.0-linux-x64-musl.tar.gz\n${HASH_B}  node-v24.21.0-linux-arm64-musl.tar.gz\n`
  )

  it('prefers the official build when both publish an archive', () => {
    expect(selectAssetSource('node-v24.21.0-linux-x64-musl.tar.gz', official, unofficial)).toEqual({
      source: 'official',
      archiveSha256: HASH_A
    })
  })

  it('falls back to unofficial builds and reports a missing archive as null', () => {
    expect(
      selectAssetSource('node-v24.21.0-linux-arm64-musl.tar.gz', official, unofficial)
    ).toEqual({ source: 'unofficial', archiveSha256: HASH_B })
    expect(selectAssetSource('node-v24.21.0-aix-ppc64.tar.gz', official, unofficial)).toBeNull()
  })
})

describe('parseNodeApiVersion', () => {
  it('reads the highest supported N-API version from node_version.h', () => {
    expect(
      parseNodeApiVersion(
        '#define NODE_API_SUPPORTED_VERSION_MAX 10\n#define NODE_API_SUPPORTED_VERSION_MIN 1\n'
      )
    ).toBe(10)
    expect(() => parseNodeApiVersion('#define NODE_MAJOR_VERSION 24')).toThrow()
  })
})

describe('compat runtime targets', () => {
  it('stay out of the default target list', () => {
    for (const target of COMPAT_SERVER_TARGETS) {
      expect(SERVER_TARGETS).not.toContain(target)
      expect(NODE_RUNTIME_ASSETS).not.toHaveProperty(target)
    }
  })

  it('resolve through nodeRuntimeAsset beside the default targets', () => {
    expect(nodeRuntimeAsset('linux-x64-glibc217')).toBe(
      NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217']
    )
    expect(nodeRuntimeAsset('linux-x64-glibc')).toBe(NODE_RUNTIME_ASSETS['linux-x64-glibc'])
    expect(nodeRuntimeAsset('linux-riscv64-glibc')).toBeUndefined()
    expect(nodeRuntimeAsset('toString')).toBeUndefined()
  })

  it('pin the unofficial build at its extracted bin/node', () => {
    const asset = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217']
    expect(asset.source).toBe('unofficial')
    expect(nodeRuntimeExecutablePath('linux-x64-glibc217', asset.archive)).toBe(
      `node-v${NODE_RUNTIME_PIN.version}-linux-x64-glibc-217/bin/node`
    )
  })
})

describe('generated block', () => {
  it('reproduces the committed table byte for byte', () => {
    const source = readFileSync(pinFile, 'utf8')
    const regenerated = replaceGeneratedBlock(
      source,
      renderGeneratedBlock(NODE_RUNTIME_PIN, NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS)
    )
    expect(regenerated).toBe(source)
  })

  it('refuses a file without markers', () => {
    expect(() => replaceGeneratedBlock('export {}\n', 'x')).toThrow(/markers/)
  })
})
