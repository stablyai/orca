import { describe, expect, it } from 'vitest'
import {
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED,
  RemoteNodeRuntimeSelfTestError,
  assertRemoteNodeRuntimePromoted
} from './orcad-remote-node-runtime-report'

const ALPINE_LOADER_ERROR =
  'Error loading shared library libstdc++.so.6: No such file or directory (needed by node)' +
  '\nError relocating node: _ZNSt7__cxx11: symbol not found'
const GLIBC_LOADER_ERROR =
  'node: error while loading shared libraries: libstdc++.so.6: cannot open shared object file: No such file or directory'

function selfTestFailure(output: string): string {
  return `${REMOTE_NODE_RUNTIME_SELFTEST_FAILED}\n${REMOTE_NODE_RUNTIME_EXIT_PREFIX}127\n${output}`
}

function thrown(promoted: string): Error {
  try {
    assertRemoteNodeRuntimePromoted(promoted)
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
  }
  throw new Error('expected the runtime self-test to fail')
}

describe('RemoteNodeRuntimeSelfTestError', () => {
  it('names a missing libstdc++ and how to install it', () => {
    const error = thrown(selfTestFailure(GLIBC_LOADER_ERROR))
    expect(error).toBeInstanceOf(RemoteNodeRuntimeSelfTestError)
    expect(error.message).toMatch(/^The host is missing libstdc\+\+\.so\.6/)
    expect(error.message).toContain('apk add libstdc++')
    expect(error.message).toContain('Then reconnect.')
    // The loader's own words stay for diagnosis.
    expect(error.message).toContain('exit 127')
    expect(error.message).toContain('cannot open shared object file')
  })

  it("names the library from musl's loader wording too (Alpine)", () => {
    const error = thrown(selfTestFailure(ALPINE_LOADER_ERROR))
    expect(error.message).toMatch(/^The host is missing libstdc\+\+\.so\.6/)
    expect(error.message).toContain('apk add libstdc++')
  })

  it('tells a NixOS host to turn on nix-ld when its stub loader refuses the runtime', () => {
    const error = thrown(
      selfTestFailure(
        'Could not start dynamically linked executable: node\n' +
          'NixOS cannot run dynamically linked executables intended for generic\n' +
          'linux environments out of the box. For more information, see:\n' +
          'https://nix.dev/permalink/stub-ld'
      )
    )
    expect(error.message).toMatch(/^NixOS can’t run Orca’s Node runtime/)
    expect(error.message).toContain('programs.nix-ld.enable = true;')
    expect(error.message).toContain('then reconnect')
    expect(error.message).toContain('stub-ld')
  })

  it('keeps the generic wording when the loader names no library', () => {
    const error = thrown(selfTestFailure('Segmentation fault'))
    expect(error.message).toMatch(/^The pinned Node runtime did not run on the host \(exit 127\)/)
    expect(error.message).toContain('Segmentation fault')
  })

  it('suggests a package for any other missing library without a guessed command', () => {
    const error = new RemoteNodeRuntimeSelfTestError(
      127,
      'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file'
    )
    expect(error.message).toMatch(/^The host is missing libatomic\.so\.1/)
    expect(error.message).toContain('Install the package that provides it.')
    expect(error.message).not.toContain('apk add')
  })
})
