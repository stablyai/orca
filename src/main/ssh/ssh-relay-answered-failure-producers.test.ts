/**
 * The real producers behind the relay ladder's "did the host answer?" question: system-ssh
 * directory upload, system sftp, and the warm runtime check. Each runs real processes where it can.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import type { SshTarget } from '../../shared/ssh-types'
import { runProcess, runProcessSync } from '@orca/process-host'
import {
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER,
  RemoteNodeRuntimeSelfTestError,
  assertRemoteNodeRuntimePromoted
} from './orcad-remote-node-runtime-report'
import { remoteNodeRuntimePresentCommand } from './orcad-remote-node-runtime'
import { isAnsweredHostFailure } from './ssh-relay-host-answered-failure'
import { classifyPinnedRuntimeFailure } from './ssh-relay-runtime-self-test'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { findSystemSsh } from './system-ssh-binary'
import { uploadDirectoryViaSystemSsh } from './system-ssh-file-transfer'
import { runSftpBatch } from './system-ssh-sftp-transfer'

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: vi.fn()
}))
vi.mock('./system-ssh-args', () => ({ buildSshArgs: () => ['--', 'host'] }))
vi.mock('./system-ssh-binary', () => ({ findSystemSsh: vi.fn(() => '/usr/bin/ssh') }))

const posix = process.platform !== 'win32'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh args are mocked, so the target is never read.
const target = {} as SshTarget
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-answered-producers-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

async function script(name: string, body: string): Promise<string> {
  const path = join(scratch, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

async function payload(): Promise<string> {
  const dir = join(scratch, 'payload')
  await mkdir(dir)
  await writeFile(join(dir, 'runtime.tar.gz'), 'fixture')
  return dir
}

describe.runIf(posix)('system-ssh directory upload', () => {
  it('reports a remote tar ENOSPC as the host answering', async () => {
    vi.mocked(findSystemSsh).mockReturnValue(
      await script(
        'ssh',
        'cat >/dev/null\necho "tar: Cannot write: No space left on device" >&2\nexit 2'
      )
    )
    const error = await uploadDirectoryViaSystemSsh(target, await payload(), '/remote').catch(
      (e: unknown) => e
    )
    expect(String(error)).toContain('No space left on device')
    expect(isAnsweredHostFailure(error)).toBe(true)
  })

  it('keeps the remote ENOSPC when the far end closes mid-stream and local tar then fails to write', async () => {
    // Why 8 MiB of noise: tar is still writing when ssh exits, so it fails downstream (BSD tar:
    // exit 1 "Write error", no signal) instead of finishing first.
    const dir = join(scratch, 'large')
    await mkdir(dir)
    await writeFile(join(dir, 'runtime.bin'), randomBytes(8 * 1024 * 1024))
    vi.mocked(findSystemSsh).mockReturnValue(
      await script(
        'ssh',
        'head -c 1024 >/dev/null\necho "tar: Cannot write: No space left on device" >&2\nexit 2'
      )
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await uploadDirectoryViaSystemSsh(target, dir, '/remote').catch(
        (e: unknown) => e
      )
      expect(String(error)).toContain('No space left on device')
      expect(isAnsweredHostFailure(error)).toBe(true)
    }
  })

  it("keeps ssh's own exit 255 (contact lost) retryable", async () => {
    vi.mocked(findSystemSsh).mockReturnValue(
      await script('ssh', 'cat >/dev/null\necho "Connection reset by peer" >&2\nexit 255')
    )
    const error = await uploadDirectoryViaSystemSsh(target, await payload(), '/remote').catch(
      (e: unknown) => e
    )
    expect(isAnsweredHostFailure(error)).toBe(false)
  })

  it('blames a local tar failure, not the remote tar that saw a truncated stream', async () => {
    vi.mocked(findSystemSsh).mockReturnValue(
      await script('ssh', 'cat >/dev/null\necho "tar: Unexpected EOF in archive" >&2\nexit 2')
    )
    const error = await uploadDirectoryViaSystemSsh(
      target,
      join(scratch, 'missing'),
      '/remote'
    ).catch((e: unknown) => e)
    expect(String(error)).toContain('local tar relay upload')
    expect(isAnsweredHostFailure(error)).toBe(false)
  })
})

describe('system sftp batch', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_SYSTEM_SFTP_PATH', '/fixture/sftp')
  })

  it('reports a Windows file permission refusal as the host answering', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'dest open "C:/Users/me/.orca-remote/node.zip": Permission denied',
      timedOut: false
    })
    const error = await runSftpBatch(target, ['put node.zip']).catch((e: unknown) => e)
    expect(String(error)).toContain('sftp batch failed (exit 1)')
    expect(isAnsweredHostFailure(error)).toBe(true)
  })

  it.each([
    [255, 'Connection closed'],
    [1, 'Connection reset by peer']
  ])('keeps a lost connection (exit %i: %s) retryable', async (code, stderr) => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      code,
      signal: null,
      stdout: '',
      stderr,
      timedOut: false
    })
    const error = await runSftpBatch(target, ['put node.zip']).catch((e: unknown) => e)
    expect(isAnsweredHostFailure(error)).toBe(false)
  })
})

describe.runIf(posix)('warm runtime check on a cached install', () => {
  const host = getRemoteHostPlatform('linux-x64')

  async function cachedRuntime(nodeBody: string): Promise<string> {
    const runtimeDir = join(scratch, 'runtime')
    await mkdir(join(runtimeDir, 'bin'), { recursive: true })
    await writeFile(join(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER), '')
    const node = join(runtimeDir, 'bin', 'node')
    await writeFile(node, `#!/bin/sh\n${nodeBody}\n`)
    await chmod(node, 0o755)
    return runtimeDir
  }

  function runCheck(runtimeDir: string, run: boolean): string {
    return runProcessSync({
      program: '/bin/sh',
      args: ['-c', remoteNodeRuntimePresentCommand(host, runtimeDir, run)]
    }).stdout
  }

  it('stays READY while the cached runtime still runs', async () => {
    const runtimeDir = await cachedRuntime(`echo v${NODE_RUNTIME_PIN.version}`)
    expect(runCheck(runtimeDir, true).trim()).toBe(REMOTE_NODE_RUNTIME_READY)
  })

  it.each([
    [
      'a shared library removed since the install',
      'echo "node: error while loading shared libraries: libatomic.so.1: cannot open shared object file" >&2\nexit 127',
      'missing_lib'
    ],
    [
      'an exec policy that now denies uploaded binaries',
      'echo "sh: node: Permission denied" >&2\nexit 126',
      'noexec'
    ]
  ])('reports %s as a classified refusal before launch', async (_label, body, refusal) => {
    const runtimeDir = await cachedRuntime(body)
    // Without running it, presence alone still says READY: the gap this check closes.
    expect(runCheck(runtimeDir, false).trim()).toBe(REMOTE_NODE_RUNTIME_READY)
    const output = runCheck(runtimeDir, true)
    let thrown: unknown
    try {
      assertRemoteNodeRuntimePromoted(output)
    } catch (error) {
      thrown = error
    }
    if (!(thrown instanceof RemoteNodeRuntimeSelfTestError)) {
      throw new Error(`expected a self-test refusal, got ${String(thrown)}`)
    }
    expect(classifyPinnedRuntimeFailure(thrown.exitStatus, thrown.output)).toBe(refusal)
    expect(isAnsweredHostFailure(thrown)).toBe(true)
  })
})
