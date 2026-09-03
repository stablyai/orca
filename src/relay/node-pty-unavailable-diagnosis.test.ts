import { describe, expect, it } from 'vitest'
import {
  diagnoseNodePtyUnavailable,
  formatNodePtyUnavailableMessage,
  type NodePtyBindingSurvey,
  type NodePtyDiagnosisInput,
  toTerminalUnavailableCause,
  type NodePtyUnavailableHost
} from './node-pty-unavailable-diagnosis'
import { parseBuildToolchainProbe } from '../main/ssh/build-toolchain-diagnosis'
import {
  mayRepairFromCause,
  parseTerminalUnavailableCause
} from '../shared/terminal-unavailable-cause'

const UBUNTU_2004: NodePtyUnavailableHost = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
  glibcVersion: '2.31',
  nodeAbi: '115',
  nodeVersion: 'v20.11.0'
}

const MODULE_DIR = '/opt/orca/relay/node_modules/node-pty'
const SEARCHED = ['build/Release', 'build/Debug', 'prebuilds/linux-x64']

const INSTALLED: NodePtyBindingSurvey = {
  moduleDir: MODULE_DIR,
  bindingPath: `${MODULE_DIR}/build/Release/pty.node`,
  searched: SEARCHED,
  builtNodeAbi: null,
  builtArch: null
}

const NOTHING_INSTALLED: NodePtyBindingSurvey = { ...INSTALLED, bindingPath: null }

/** What node-pty itself throws: the real cause replaced by its LAST directory miss. */
const FLATTENED =
  'Failed to load native module: pty.node, checked: build/Release, build/Debug, ' +
  "prebuilds/linux-x64: Error: Cannot find module '../prebuilds/linux-x64//pty.node'"

const diagnose = (overrides: Partial<NodePtyDiagnosisInput> = {}) =>
  diagnoseNodePtyUnavailable({
    host: UBUNTU_2004,
    survey: INSTALLED,
    requireError: FLATTENED,
    ...overrides
  })

const message = (overrides: Partial<NodePtyDiagnosisInput> = {}) =>
  formatNodePtyUnavailableMessage(diagnose(overrides))

const toolchain = (present: readonly string[]) =>
  parseBuildToolchainProbe([...present.map((tool) => `HAVE ${tool}`), 'PKG apt-get'].join('\n'))

describe('diagnoseNodePtyUnavailable', () => {
  it("never treats node-pty's flattened wrapper as the cause", () => {
    // node-pty rethrows only its last directory miss, so acting on that text sends the
    // user to install a module that is already installed.
    expect(
      diagnose({ survey: NOTHING_INSTALLED, toolchain: toolchain(['make', 'g++', 'python3']) })
    ).toMatchObject({ reason: 'dependency_missing' })
    expect(diagnose().reason).not.toBe('dependency_missing')
  })

  it('names the glibc the host actually has next to the one the binary needs', () => {
    const verdict = diagnose({
      loaderError:
        "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /opt/orca/node_modules/node-pty/build/Release/pty.node)"
    })
    expect(verdict).toMatchObject({ status: 'blocked', reason: 'libc_floor' })
    const text = formatNodePtyUnavailableMessage(verdict)
    expect(text).toContain('GLIBC_2.34')
    expect(text).toContain('glibc 2.31')
    // The remedy is a rebuild; offering "install build-essential" here is a wrong answer.
    expect(text).not.toContain('build tools')
  })

  it('names both ABI numbers from the loader message', () => {
    const text = message({
      loaderError:
        'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. ' +
        'This version of Node.js requires NODE_MODULE_VERSION 127.'
    })
    expect(text).toContain('built for Node ABI 115, this host runs ABI 127')
    expect(text).toContain('v20.11.0')
  })

  it("reads the ABI mismatch off node-gyp's build record when the loader said nothing", () => {
    // The case the old message could only hedge about: the binding is present, node-pty
    // destroyed the loader error, and the only evidence left is what node-gyp configured.
    const text = message({
      survey: { ...INSTALLED, builtNodeAbi: '127' }
    })
    expect(text).toContain('built for Node ABI 127, this host runs ABI 115')
  })

  it('separates an architecture mismatch from an ABI mismatch', () => {
    expect(diagnose({ loaderError: 'invalid ELF header' }).reason).toBe('arch_mismatch')
    expect(message({ survey: { ...INSTALLED, builtArch: 'arm64' } })).toContain(
      'built for arm64, this host runs x64'
    )
    expect(
      message({
        loaderError:
          "dlopen(/opt/pty.node, 0x0001): tried: '/opt/pty.node' (mach-o file, but is an " +
          "incompatible architecture (have 'arm64', need 'x86_64'))"
      })
    ).toContain('built for arm64, this host needs x86_64')
  })

  it('separates a missing shared library from a libc floor break', () => {
    // Different remedies: install a package, versus rebuild against an older toolchain.
    const verdict = diagnose({
      loaderError: 'libstdc++.so.6: cannot open shared object file: No such file or directory'
    })
    expect(verdict.reason).toBe('shared_library_missing')
    const text = formatNodePtyUnavailableMessage(verdict)
    expect(text).toContain('libstdc++.so.6 is not installed on this host')
    expect(text).toContain('Install that library')
  })

  it('offers the build-tools remedy only when it probed the toolchain and found it missing', () => {
    const missing = diagnose({
      survey: NOTHING_INSTALLED,
      toolchain: toolchain(['python3'])
    })
    expect(missing.reason).toBe('toolchain_missing')
    const text = formatNodePtyUnavailableMessage(missing)
    expect(text).toContain('make and a C++ compiler are not installed')
    expect(text).toContain(`checked ${SEARCHED.join(', ')} under ${MODULE_DIR}`)
    expect(text).toContain('sudo apt-get install -y build-essential python3')

    // Toolchain present and nothing compiled: the install failed for another reason, and
    // "install make/g++/python3" would send the user chasing tools they already have.
    const present = diagnose({
      survey: NOTHING_INSTALLED,
      toolchain: toolchain(['make', 'g++', 'python3'])
    })
    expect(present.reason).toBe('dependency_missing')
    expect(formatNodePtyUnavailableMessage(present)).not.toContain('apt-get')
  })

  it('reports a binding that killed the probe as a crash rather than a miss', () => {
    const text = message({ probeSignal: 'SIGSEGV' })
    expect(text).toContain('SIGSEGV')
    expect(text).toContain('incompatible with this host rather than missing')
  })

  it('quotes the loader verbatim when nothing recognizes it', () => {
    const raw = 'dlopen(/opt/pty.node): unexpected relocation kind 0x9f'
    const verdict = diagnose({ loaderError: raw })
    expect(verdict).toMatchObject({ status: 'blocked', reason: 'load_failed', rawError: raw })
    const text = formatNodePtyUnavailableMessage(verdict)
    expect(text).toContain(`Loader error: ${raw}`)
    expect(text).toContain('file an issue')
  })

  it('reports a probe that never answered as unverifiable and diagnoses nothing', () => {
    // docs/reference/ssh-execution-boundary.md: loss of contact is not a verdict.
    const verdict = diagnose({
      unverifiableBecause: 'the node-pty load probe did not finish in time'
    })
    expect(verdict.status).toBe('unverifiable')
    const text = formatNodePtyUnavailableMessage(verdict)
    expect(text).toContain('could not establish why')
    expect(text).toContain('not evidence node-pty is broken')
    expect(text).not.toContain('Reconnect to rebuild')
    expect(text).not.toContain('apt-get')
  })

  it('marks rebuildable faults repairable and everything else not', () => {
    // The relay's node-pty is compiled ON the remote, so a binding that no longer matches
    // the machine is fixed by recompiling there. A missing compiler or a missing library
    // is not: the rebuild would need the very thing that is absent.
    const repairable = (overrides: Partial<NodePtyDiagnosisInput>) =>
      toTerminalUnavailableCause(diagnose(overrides)).repairable

    expect(repairable({ survey: { ...INSTALLED, builtNodeAbi: '127' } })).toBe(true)
    expect(repairable({ survey: { ...INSTALLED, builtArch: 'arm64' } })).toBe(true)
    expect(repairable({ loaderError: "version `GLIBC_2.34' not found" })).toBe(true)
    expect(repairable({ probeSignal: 'SIGSEGV' })).toBe(true)
    expect(
      repairable({ survey: NOTHING_INSTALLED, toolchain: toolchain(['make', 'g++', 'python3']) })
    ).toBe(true)

    expect(repairable({ survey: NOTHING_INSTALLED, toolchain: toolchain(['python3']) })).toBe(false)
    expect(repairable({ loaderError: 'libstdc++.so.6: cannot open shared object file' })).toBe(
      false
    )
    // Nothing was established, so nothing may be rewritten on the host (#14830).
    expect(repairable({ unverifiableBecause: 'probe timed out' })).toBe(false)
  })

  it('publishes a cause that survives its own wire schema', () => {
    const cause = toTerminalUnavailableCause(
      diagnose({ loaderError: "version `GLIBC_2.34' not found" })
    )
    expect(parseTerminalUnavailableCause(cause)).toEqual(cause)
    expect(mayRepairFromCause(cause)).toBe(true)
    expect(cause.host).toMatchObject({ arch: 'x64', nodeAbi: '115', glibcVersion: '2.31' })

    // A peer claiming repairable on an unverifiable status must not be believed.
    expect(mayRepairFromCause({ ...cause, status: 'unverifiable' })).toBe(false)
    expect(parseTerminalUnavailableCause({ ...cause, host: undefined })).toBeNull()
    // A reason this client has never heard of must not discard the whole cause; the
    // relay may name faults added after the client shipped.
    expect(parseTerminalUnavailableCause({ ...cause, reason: 'invented_later' })).not.toBeNull()
  })

  it('puts the host on every message so a bug report needs no follow-up question', () => {
    for (const overrides of [
      {},
      { loaderError: 'invalid ELF header' },
      { unverifiableBecause: 'probe timed out' }
    ]) {
      expect(message(overrides)).toContain(
        'linux/x64, glibc 2.31, Node v20.11.0 (ABI 115), prebuild slot linux-x64-glibc'
      )
    }
  })
})
