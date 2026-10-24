import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  ensureRemoteOrcadNodeRuntime,
  posixNodeRuntimeExecutable,
  probeRemoteNodeRuntimeCommand,
  remoteNodeRuntimeDir
} from './orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from '../../ssh/orcad-remote-node-runtime-report'
import {
  recordedNodeRuntimeProbeCommand,
  recordedRemoteNodeRuntimeProbeCommand,
  REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME
} from './orcad-remote-node-runtime-recorded-probe'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand, which runs it in a local shell.
const conn = {} as OrcadHostTransport
const host = getRemoteHostPlatform('linux-x64')
const target = 'linux-x64-glibc'
const pin = pinnedNodeRuntimeAsset(target).executableSha256
let root: string
let shim: string
let runtimeDir: string

async function sh(command: string): Promise<string> {
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', `PATH=${shim}:$PATH; ${command}`],
    timeoutMs: 30_000
  })
  if (result.code !== 0) {
    throw new Error(`exit ${result.code}: ${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

function hashCount(): number {
  try {
    return readFileSync(join(root, 'hashes'), 'utf8').length
  } catch {
    return 0
  }
}

function ensure(recorded: boolean): ReturnType<typeof ensureRemoteOrcadNodeRuntime> {
  return ensureRemoteOrcadNodeRuntime({
    conn,
    host,
    slotDir: join(root, '.orca-remote', 'orcad-0.1.0+abc'),
    target,
    archivePath: () => Promise.reject(new Error('no upload expected')),
    ...(recorded ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand } : {})
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-recorded-probe-'))
  shim = join(root, 'shim')
  mkdirSync(shim)
  // Count full executable hashes behind this stubbed pin.
  writeFileSync(
    join(shim, 'sha256sum'),
    `#!/bin/sh\nprintf x >> ${JSON.stringify(join(root, 'hashes'))}\necho "${pin}  $1"\n`,
    { mode: 0o755 }
  )
  runtimeDir = remoteNodeRuntimeDir(host, join(root, '.orca-remote', 'orcad-0.1.0+abc'), target)
  mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
  writeFileSync(posixNodeRuntimeExecutable(host, runtimeDir), 'node', { mode: 0o755 })
  writeFileSync(join(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER), '')
  vi.mocked(execCommand).mockReset()
  vi.mocked(execCommand).mockImplementation((_conn, command) => sh(command))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('recorded runtime probe', () => {
  it('hashes once, then trusts the unchanged executable by its stat signature', async () => {
    await expect(ensure(true)).resolves.toMatchObject({ transfer: 'cached' })
    expect(hashCount()).toBe(1)
    expect(
      readFileSync(join(runtimeDir, REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME), 'utf8')
    ).toMatch(/\S/)
    await expect(ensure(true)).resolves.toMatchObject({ transfer: 'cached' })
    expect(hashCount()).toBe(1)
  })

  it('hashes a same-size in-place rewrite after its stat signature changes', async () => {
    await ensure(true)
    const executable = posixNodeRuntimeExecutable(host, runtimeDir)
    const before = statSync(executable)
    writeFileSync(executable, 'NODE')
    // Force signature change when fast writes share filesystem clock resolution.
    utimesSync(executable, before.atime, new Date(before.mtimeMs + 1_000))
    const after = statSync(executable)
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs)
    await ensure(true)
    expect(hashCount()).toBe(2)
  })

  it('never trusts a recorded signature for another pin', async () => {
    await ensure(true)
    const probe = recordedNodeRuntimeProbeCommand(host, runtimeDir, 'f'.repeat(64))
    expect(await sh(probe)).toBe(REMOTE_NODE_RUNTIME_MISSING)
    expect(hashCount()).toBe(2)
  })

  it('reports a runtime without its verified marker as missing, whatever is recorded', async () => {
    await ensure(true)
    rmSync(join(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER))
    const probe = recordedRemoteNodeRuntimeProbeCommand(host, runtimeDir, target)
    expect(await sh(probe)).toBe(REMOTE_NODE_RUNTIME_MISSING)
  })

  it('keeps the default probe byte-identical and hashing on every call (SSH hosts)', async () => {
    await ensure(false)
    await ensure(false)
    const sent = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    expect(sent).toEqual([
      probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
      probeRemoteNodeRuntimeCommand(host, runtimeDir, target)
    ])
    expect(hashCount()).toBe(2)
  })
})
