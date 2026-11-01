import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildNodePtyLoadProbeScript,
  checkNodePtyPrecondition,
  classifyNodePtyProbeResult,
  formatNodePtyPreconditionReport,
  probeLocalBuildToolchainHints
} from './node-pty-precondition'
import { detectNativeHostAbi, hostNodeApiVersion, type NativeHostAbi } from './native-host-abi'

function writeHostSlotManifest(prebuildsDir: string, slot: string, abi: NativeHostAbi): void {
  const files = Object.fromEntries(
    readdirSync(join(prebuildsDir, slot)).map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(prebuildsDir, slot, file)))
        .digest('hex')
    ])
  )
  const napi = hostNodeApiVersion() ?? 8
  writeFileSync(
    join(prebuildsDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      module: 'node-pty',
      version: '1.1.0',
      napi,
      slots: {
        [slot]: {
          platform: abi.platform,
          arch: abi.arch,
          libc: abi.libc,
          glibc: null,
          napi,
          files
        }
      }
    })
  )
}

const require = createRequire(import.meta.url)
const REAL_NODE_PTY = dirname(require.resolve('node-pty/package.json'))
const REAL_PTY_NODE = join(REAL_NODE_PTY, 'build', 'Release', 'pty.node')

// Probe real binding loads in a child: file presence can hide an Electron/Node ABI mismatch.
const REAL_SPAWN_HELPER = join(REAL_NODE_PTY, 'build', 'Release', 'spawn-helper')

const realNodePtyLoads = ((): boolean => {
  if (!existsSync(REAL_PTY_NODE)) {
    return false
  }
  // Only macOS builds spawn-helper; load-success tests there must also require it.
  if (process.platform === 'darwin' && !existsSync(REAL_SPAWN_HELPER)) {
    return false
  }
  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(REAL_PTY_NODE)})`], {
    encoding: 'utf8',
    timeout: 30_000
  })
  return !probe.error && probe.status === 0
})()

const probe = (overrides: Partial<Parameters<typeof classifyNodePtyProbeResult>[0]> = {}) =>
  classifyNodePtyProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  })

const reported = (message: string) =>
  classifyNodePtyProbeResult({
    code: 4,
    signal: null,
    stdout: `ORCA_NODE_PTY_LOAD_ERROR ${JSON.stringify(message)}\n`,
    stderr: '',
    timedOut: false
  })

describe('classifyNodePtyProbeResult', () => {
  it('accepts only a clean exit that printed the token', () => {
    expect(probe({ code: 0, stdout: 'ORCA_NODE_PTY_LOAD_OK /x/build/Release' })).toBeNull()
    expect(probe({ code: 0, stdout: '' })?.reason).toBe('load_failed')
  })

  it('names the glibc floor for the #9902 loader message', () => {
    expect(
      reported(
        "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /app/node_modules/node-pty/build/Release/pty.node)"
      )
    ).toEqual({
      status: 'blocked',
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34'
    })
  })

  it('names a libstdc++ floor break too', () => {
    expect(reported("version `GLIBCXX_3.4.29' not found")?.reason).toBe('libc_floor')
  })

  it('separates a Node ABI mismatch from a libc mismatch', () => {
    expect(
      reported(
        'was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.'
      )
    ).toEqual({
      status: 'blocked',
      reason: 'abi_mismatch',
      detail: 'built for Node ABI 115, this host runs ABI 127'
    })
  })

  it('reports a signalled probe as a crash, even with no output at all', () => {
    expect(probe({ code: null, signal: 'SIGSEGV' })).toEqual({
      status: 'blocked',
      reason: 'load_crashed',
      detail: 'the load probe was killed by SIGSEGV'
    })
  })

  it('distinguishes no binary anywhere from a binary the loader refused', () => {
    expect(probe({ code: 3, stdout: 'ORCA_NODE_PTY_NO_BINARY\n' })).toEqual({
      status: 'blocked',
      reason: 'dependency_missing',
      detail: 'node-pty is installed but has no compiled binary for this platform'
    })
    expect(reported('dlopen(...): slice is not valid mach-o file')?.reason).toBe('load_failed')
  })

  it('ignores its own token strings echoed back inside the child stderr', () => {
    // Node echoes eval source into stderr; matching its tokens would misclassify loader failure.
    const echoedSource =
      '[eval]:1\nif(!f){console.log("ORCA_NODE_PTY_NO_BINARY");process.exit(3)}\n' +
      '        ^\n\nError: dlopen(/app/pty.node): slice is not valid mach-o file\n'

    expect(
      classifyNodePtyProbeResult({
        code: 4,
        signal: null,
        stdout: `ORCA_NODE_PTY_LOAD_ERROR ${JSON.stringify('dlopen(/app/pty.node): slice is not valid mach-o file')}`,
        stderr: echoedSource,
        timedOut: false
      })
    ).toMatchObject({ reason: 'load_failed' })
  })

  it('reads past node\u2019s echoed source line when it can only use stderr', () => {
    const failure = probe({
      stderr:
        '[eval]:1\nprocess.dlopen({exports:{}},f);\n        ^\n\nError: something specific went wrong\n'
    })
    expect(failure?.detail).toBe('Error: something specific went wrong')
  })

  it('calls a timeout unverifiable rather than blocked', () => {
    expect(probe({ timedOut: true })).toEqual({
      status: 'unverifiable',
      reason: 'unknown',
      detail: 'the node-pty load probe did not finish in time, so nothing was established'
    })
  })
})

describe('buildNodePtyLoadProbeScript', () => {
  it('loads through absolute paths so the child cannot resolve a different copy', () => {
    const script = buildNodePtyLoadProbeScript('/opt/app/node_modules/node-pty')
    expect(script).toContain('"/opt/app/node_modules/node-pty/lib/index.js"')
    expect(script).toContain('"/opt/app/node_modules/node-pty/lib/utils.js"')
    expect(script).toContain('loadNativeModule')
    // Windows loads conpty lazily at first spawn, so requiring the package proves too little.
    expect(script).toContain('conpty')
    // Raw dlopen must precede the wrapper that hides loader errors as module misses.
    expect(script.indexOf('process.dlopen')).toBeLessThan(script.indexOf('lib/index.js'))
  })
})

describe('checkNodePtyPrecondition', () => {
  const temporaryDirs: string[] = []
  const stageNodePty = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-node-pty-'))
    temporaryDirs.push(root)
    const dir = join(root, 'node-pty')
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'lib'), join(dir, 'lib'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'package.json'), join(dir, 'package.json'))
    return dir
  }

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a native binary that the dynamic loader refuses', () => {
    const dir = stageNodePty()
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), Buffer.from('not a native addon'))

    const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

    expect(verdict.status).toBe('blocked')
    expect(verdict.reason).toBeDefined()
    expect(verdict.reason).not.toBe('spawn_helper_missing')
  })

  it('blocks when node-pty is not resolvable at all', () => {
    const verdict = checkNodePtyPrecondition({ nodePtyDir: null, prebuildsDir: null })
    expect(verdict).toMatchObject({ status: 'blocked', reason: 'dependency_missing' })
  })

  it('returns a self-consistent verdict against the real host', () => {
    // Prepared hosts and CI can honestly yield different load verdicts; do not predict one.
    const verdict = checkNodePtyPrecondition({ prebuildsDir: null })

    // Every non-ok verdict must carry an established cause.
    expect(['ok', 'degraded', 'blocked', 'unverifiable']).toContain(verdict.status)
    if (verdict.status !== 'ok') {
      expect(verdict.reason).toBeDefined()
      expect(verdict.reason).not.toBe('unknown')
    }
    expect(verdict.slot).toBe(
      process.platform === 'linux'
        ? `linux-${process.arch}-${verdict.abi.libc}`
        : `${process.platform}-${process.arch}`
    )
  })

  // This load-outcome assertion needs a real Node-ABI binding and macOS-only spawn-helper.
  it.runIf(process.platform === 'darwin' && realNodePtyLoads)(
    'degrades rather than blocks when only spawn-helper is missing',
    () => {
      const dir = stageNodePty()
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
        join(dir, 'build', 'Release', 'pty.node')
      )

      const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

      expect(verdict).toMatchObject({ status: 'degraded', reason: 'spawn_helper_missing' })
    }
  )

  // Simulate Linux to prove it never requires macOS-only spawn-helper; require a loadable binding.
  it.runIf(process.platform !== 'win32' && realNodePtyLoads)(
    'does not call a Linux host degraded over a spawn-helper it never execs',
    () => {
      const dir = stageNodePty()
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
        join(dir, 'build', 'Release', 'pty.node')
      )
      expect(existsSync(join(dir, 'build', 'Release', 'spawn-helper'))).toBe(false)

      const verdict = checkNodePtyPrecondition({
        nodePtyDir: dir,
        prebuildsDir: null,
        abi: { platform: 'linux', arch: 'x64', libc: 'glibc', glibcVersion: '2.31', nodeAbi: '127' }
      })

      expect(verdict).toMatchObject({ status: 'ok', slot: 'linux-x64-glibc' })
      expect(verdict.reason).toBeUndefined()
    }
  )

  // Placement works with fake payloads; successful load outcomes require a prepared real binding.
  it('places the matching slot even when the payload is not loadable', () => {
    const dir = stageNodePty()
    const abi = detectNativeHostAbi()
    const slot =
      abi.libc === 'none'
        ? `${abi.platform}-${abi.arch}`
        : `${abi.platform}-${abi.arch}-${abi.libc}`
    const prebuildsDir = mkdtempSync(join(tmpdir(), 'orcad-prebuilds-'))
    temporaryDirs.push(prebuildsDir)
    mkdirSync(join(prebuildsDir, slot), { recursive: true })
    writeFileSync(join(prebuildsDir, slot, 'pty.node'), 'not a real binding')
    if (process.platform !== 'win32') {
      writeFileSync(join(prebuildsDir, slot, 'spawn-helper'), '#!/bin/sh\nexit 0\n')
    }
    writeHostSlotManifest(prebuildsDir, slot, abi)

    const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir })

    expect(verdict.prebuilt).toMatchObject({ installed: true, slot })
    expect(verdict.status).not.toBe('ok')
    expect(verdict.reason).toBeDefined()
  })

  it.runIf(realNodePtyLoads)(
    'reports ok once a loadable slot is installed (needs a Node-ABI build)',
    () => {
      const dir = stageNodePty()
      const abi = detectNativeHostAbi()
      const slot =
        abi.libc === 'none'
          ? `${abi.platform}-${abi.arch}`
          : `${abi.platform}-${abi.arch}-${abi.libc}`
      const prebuildsDir = mkdtempSync(join(tmpdir(), 'orcad-prebuilds-'))
      temporaryDirs.push(prebuildsDir)
      mkdirSync(join(prebuildsDir, slot), { recursive: true })
      cpSync(REAL_PTY_NODE, join(prebuildsDir, slot, 'pty.node'))
      const helper = REAL_SPAWN_HELPER
      if (process.platform !== 'win32' && existsSync(helper)) {
        cpSync(helper, join(prebuildsDir, slot, 'spawn-helper'))
      }
      writeHostSlotManifest(prebuildsDir, slot, abi)

      const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir })

      expect(verdict.prebuilt).toMatchObject({ installed: true, slot })
      expect(verdict.status).toBe('ok')
    }
  )
})

describe('formatNodePtyPreconditionReport', () => {
  it('names the host, the slot and the action', () => {
    const report = formatNodePtyPreconditionReport(
      {
        status: 'blocked',
        slot: 'linux-x64-musl',
        abi: {
          platform: 'linux',
          arch: 'x64',
          libc: 'musl',
          glibcVersion: null,
          nodeAbi: '127'
        },
        reason: 'dependency_missing',
        prebuilt: { installed: false, slot: 'linux-x64-musl', why: 'no-slot' }
      },
      'Terminals are unavailable on this host.',
      ['  sudo apk add build-base python3']
    )

    expect(report).toContain('platform linux/x64')
    expect(report).toContain('libc musl')
    expect(report).toContain('prebuild slot linux-x64-musl')
    expect(report).toContain('No shipped prebuilt matches slot linux-x64-musl.')
    expect(report).toContain('sudo apk add build-base python3')
  })
})

describe('probeLocalBuildToolchainHints', () => {
  it('gives macOS the Xcode command line tools, not a Linux package manager', () => {
    const hints = probeLocalBuildToolchainHints('darwin')
    expect(hints).toEqual(['  xcode-select --install'])
    expect(hints.join('\n')).not.toMatch(/apt-get|dnf|pacman|apk/)
  })

  it('says nothing on Windows, where node-pty ships prebuilds', () => {
    expect(probeLocalBuildToolchainHints('win32')).toEqual([])
  })

  it.runIf(process.platform === 'linux')('reuses the relay diagnosis on Linux', () => {
    expect(probeLocalBuildToolchainHints('linux').length).toBeGreaterThan(0)
  })
})
