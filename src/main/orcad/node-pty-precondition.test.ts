import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { detectNativeHostAbi } from './native-host-abi'

const require = createRequire(import.meta.url)
const REAL_NODE_PTY = dirname(require.resolve('node-pty/package.json'))
const REAL_PTY_NODE = join(REAL_NODE_PTY, 'build', 'Release', 'pty.node')

/**
 * Whether this host's compiled node-pty actually loads under plain Node.
 *
 * Why not existsSync: CI ships a pty.node built for Electron's ABI, so the file is
 * present and `require` still fails. Gating on existence ran the load-dependent tests
 * on a host that could never satisfy them. Probed in a child so a bad binding cannot
 * take the test runner down with it.
 */
const REAL_SPAWN_HELPER = join(REAL_NODE_PTY, 'build', 'Release', 'spawn-helper')

const realNodePtyLoads = ((): boolean => {
  if (!existsSync(REAL_PTY_NODE)) {
    return false
  }
  // Why spawn-helper too: a slot without it is legitimately 'degraded', so a test that
  // expects 'ok' has an unsatisfiable premise on a host that lacks it. CI has the
  // binding but not the helper, which is what made the previous gate insufficient.
  if (process.platform !== 'win32' && !existsSync(REAL_SPAWN_HELPER)) {
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
    // A zero exit with no token means the probe never reached the load.
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
    // These need different fixes — rebuild against this Node vs. build on an older libc —
    // so collapsing them sends the operator to the wrong one.
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
    // The uncatchable case: a binary that aborts inside the loader never reaches the
    // child's catch and often prints nothing.
    expect(probe({ code: null, signal: 'SIGSEGV' })).toEqual({
      status: 'blocked',
      reason: 'load_crashed',
      detail: 'the load probe was killed by SIGSEGV'
    })
  })

  it('distinguishes no binary anywhere from a binary the loader refused', () => {
    // "install node-pty" and "rebuild node-pty for this libc" are different instructions.
    expect(probe({ code: 3, stdout: 'ORCA_NODE_PTY_NO_BINARY\n' })).toEqual({
      status: 'blocked',
      reason: 'dependency_missing',
      detail: 'node-pty is installed but has no compiled binary for this platform'
    })
    expect(reported('dlopen(...): slice is not valid mach-o file')?.reason).toBe('load_failed')
  })

  it('ignores its own token strings echoed back inside the child stderr', () => {
    // node prints the whole `-e` source above the stack trace, and that source contains
    // every token below. Matching on stderr made a refused binary read as "not installed".
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
    // A probe that never answered is not evidence that node-pty is broken, and refusing
    // to boot on it would take down hosts that work.
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
    // Windows defers conpty.node to first spawn, so requiring the package proves nothing there.
    expect(script).toContain('conpty')
    // The raw dlopen must precede requiring the package, or node-pty's own loader
    // re-wraps the loader error into a misleading "Cannot find module".
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
    // The whole reason the probe is a child process: this file is loaded with dlopen, and
    // an in-process require of it can take the host down before any handler runs. Reaching
    // the assertion below at all is the evidence.
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
    // Why not a predicted status: this depends on how the host was prepared. CI's test
    // shard runs `vitest` directly, so `ensure-native-runtime --runtime=node` never
    // builds node-pty for the Node ABI and `degraded` is correct there; a prepared
    // checkout gives 'ok'. Predicting either encodes an environment.
    //
    // Why not require('node-pty') as ground truth: that resolves the JS wrapper while
    // the native binding loads lazily, so it proves strictly less than this checks —
    // that was the first version of this test and it failed on CI for that reason.
    //
    // What is invariant: on a host where node-pty is installed at all, the verdict is
    // never 'blocked' and never carries an unestablished reason.
    const verdict = checkNodePtyPrecondition({ prebuildsDir: null })

    // Why not a fixed status: a prepared host gives 'ok', CI's unprepared shard gives
    // 'degraded', and a corrupt binding gives 'blocked' — all three are honest. What is
    // invariant is that anything other than 'ok' names an established cause, so the
    // host can never decline a terminal for a reason it did not work out.
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

  // Why gated on the real binding: this asserts a LOAD outcome, so it needs a pty.node
  // built for the Node ABI. CI's shard never runs ensure-native-runtime, so the copy
  // ENOENT'd there.
  it.runIf(process.platform !== 'win32' && realNodePtyLoads)(
    'degrades rather than blocks when only spawn-helper is missing',
    () => {
      // node-pty posix_spawns spawn-helper, so this host loads fine and then fails ENOENT
      // the first time someone opens a terminal. Everything else it serves still works.
      const dir = stageNodePty()
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
        join(dir, 'build', 'Release', 'pty.node')
      )

      const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

      expect(verdict).toMatchObject({ status: 'degraded', reason: 'spawn_helper_missing' })
    }
  )

  // Why split: the "ok" half needs a REAL loadable pty.node, which only exists after
  // `ensure-native-runtime --runtime=node`. CI's shard runs vitest directly, so copying
  // from node_modules ENOENT'd there. Slot *placement* is the logic worth checking on
  // every host; the load verdict needs a prepared one.
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

    const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir })

    // Installed from the right slot, and honest that the payload does not load.
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
    // The relay's hint list answers with a cross-distro apt/dnf/pacman/apk menu when it
    // finds no package manager. On macOS every line of that menu is wrong.
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
