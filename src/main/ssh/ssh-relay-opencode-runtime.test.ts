import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  upload: vi.fn(),
  write: vi.fn(),
  materialize: vi.fn(),
  target: vi.fn(),
  warm: false,
  checksumError: false,
  cleanupError: false,
  reservationError: false
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: mocks.exec,
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    'sshChannelCloseConfirmed' in error &&
    error.sshChannelCloseConfirmed === false
}))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: mocks.upload,
  writeRelayFile: mocks.write
}))
vi.mock('./pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: mocks.materialize,
  materializeCachedNodeRuntime: vi.fn()
}))
vi.mock('./orcad-deployment-target', () => ({ resolveOrcadDeploymentTargetFacts: mocks.target }))

import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import { ensureRemoteOpenCodeRuntime } from './ssh-relay-opencode-runtime'
import { OPENCODE_RUNTIME_RESULT } from './ssh-relay-opencode-runtime-commands'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

const host = getRemoteHostPlatform('linux-x64')
const remoteHome = '/home/ada'
const relayDir = `${remoteHome}/.orca-remote/relay-build`
const binary = `${remoteHome}/.orca-remote/runtimes/node-${NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256}/bin/node`
const archiveName = 'node-v24.21.0-linux-x64.tar.gz'
let cacheRoot: string
let runtime: string
const frame = (status: string, executable?: string) =>
  `${OPENCODE_RUNTIME_RESULT}${JSON.stringify({ status, executable })}\n`
const options = () => ({ nodePath: '/usr/bin/node', relayDir, cacheRoot })

function hostCommandResult(command: string): string {
  if (command.includes('staging quota is full')) {
    if (mocks.reservationError) {
      throw new Error('staging quota is full')
    }
    return `__ORCA_UPLOAD_STAGE_SLOT__${command.match(/\.sftp-namespace-[0-9a-f]{32}/)?.[0]}:slot-0`
  }
  if (command.includes("/runtimes/.store-lock' 2>/dev/null")) {
    return 'OK'
  }
  if (command.includes('SELECT 1 AS ready')) {
    return frame('unsupported')
  }
  if (command.includes('ORCA_NODE_RUNTIME_EXTRACT_FAILED')) {
    return mocks.checksumError ? 'ORCA_NODE_RUNTIME_HASH_MISMATCH' : 'ORCA_NODE_RUNTIME_READY'
  }
  if (command.includes('ORCA_NODE_RUNTIME_MISSING')) {
    return mocks.warm ? 'ORCA_NODE_RUNTIME_READY' : 'ORCA_NODE_RUNTIME_MISSING'
  }
  if (command.includes('published')) {
    return frame('published')
  }
  if (mocks.cleanupError && command.includes('claim_identity') && !command.includes('old=')) {
    throw Object.assign(new Error('Cleanup teardown is unconfirmed'), {
      sshChannelCloseConfirmed: false
    })
  }
  return ''
}

function connection(system = false): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Setup reads only the mocked transport flag and connection generation; remote I/O is mocked.
  return {
    usesSystemSshTransport: () => system,
    getConnectGeneration: () => 1
  } as unknown as SshConnection
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  cacheRoot = await mkdtemp(join(tmpdir(), 'orca-vault-runtime-'))
  runtime = join(cacheRoot, archiveName)
  await writeFile(runtime, 'verified runtime')
  mocks.materialize.mockResolvedValue(runtime)
  mocks.target.mockResolvedValue({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 31 } })
  mocks.warm = false
  mocks.checksumError = false
  mocks.cleanupError = false
  mocks.reservationError = false
  mocks.exec.mockImplementation(async (_conn, command: string) => hostCommandResult(command))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('SSH OpenCode runtime setup', () => {
  it('publishes a capable existing Node without materializing or uploading a runtime', async () => {
    mocks.exec.mockResolvedValueOnce(frame('ready', '/opt/node 24/bin/node'))
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'ready'
    )
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({
      protocol: 1,
      executable: '/opt/node 24/bin/node'
    })
  })

  it('installs the pinned Node archive into the shared runtimes/ store after the read probe fails', async () => {
    mocks.upload.mockImplementation(async (_conn, localDir: string, remoteDir: string) => {
      expect(remoteDir).toMatch(
        /\/\.orca-remote\/runtimes\/\.stage-node-[0-9a-f]{64}-[0-9a-f]{16}$/
      )
      expect(await readdir(localDir)).toEqual([archiveName])
      expect(await readFile(join(localDir, archiveName), 'utf8')).toBe('verified runtime')
    })
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'ready'
    )
    expect(mocks.target).toHaveBeenCalledWith(
      expect.objectContaining({ host, signal: expect.any(AbortSignal) })
    )
    expect(mocks.materialize).toHaveBeenCalledWith('linux-x64-glibc', cacheRoot, {
      signal: expect.any(AbortSignal)
    })
    expect(await readdir(cacheRoot)).toEqual([archiveName])
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({ protocol: 1, executable: binary })
    const commands: string[] = mocks.exec.mock.calls.map(([, command]) => command)
    expect(commands.some((command) => command.includes('vault-sqlite'))).toBe(false)
  })

  it('reuses a runtime the host store already verified without downloading it again', async () => {
    mocks.warm = true
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'ready'
    )
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({ protocol: 1, executable: binary })
  })

  it('writes the reference atomically through the reserved staging namespace', async () => {
    await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    const writeOptions = mocks.write.mock.calls[0][4]
    expect(writeOptions.sftpNamespace.homeRelativeNamespaceRoot).toMatch(
      /^\.orca-remote\/\.upload-stages\/slot-0$/
    )
    expect(writeOptions.sftpNamespace.homeRelativePath).toMatch(/\/opencode-sqlite-runtime\.json$/)
  })

  it('skips namespace probing on system SSH', async () => {
    await ensureRemoteOpenCodeRuntime(connection(true), host, remoteHome, options())
    expect(mocks.write.mock.calls[0][4].sftpNamespace).toBeUndefined()
  })

  it('coalesces repeated setup for one execution connection and directory', async () => {
    const conn = connection()
    const result = await Promise.all([
      ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options()),
      ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    ])
    expect(result).toEqual(['ready', 'ready'])
    expect(mocks.upload).toHaveBeenCalledOnce()
  })

  it('coalesces the bounded target cache fill across hosts', async () => {
    let finish!: (path: string) => void
    mocks.materialize.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const first = ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    const second = ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    await vi.waitFor(() => expect(mocks.materialize).toHaveBeenCalledOnce())
    finish(runtime)
    expect(await Promise.all([first, second])).toEqual(['ready', 'ready'])
    expect(mocks.upload).toHaveBeenCalledTimes(2)
  })

  it('never publishes a reference after a failed remote runtime checksum', async () => {
    mocks.checksumError = true
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'failed'
    )
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('aborts an upload without publishing or running further host commands', async () => {
    const controller = new AbortController()
    mocks.upload.mockImplementation(async (_conn, _local, _remote, _host, transfer) => {
      controller.abort()
      transfer.signal.throwIfAborted()
    })
    expect(
      await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, {
        ...options(),
        signal: controller.signal
      })
    ).toBe('teardown-unconfirmed')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledTimes(3)
  })

  it('bounds even an unresponsive setup operation at 180 seconds', async () => {
    vi.useFakeTimers()
    mocks.exec.mockReturnValue(new Promise(() => {}))
    const conn = connection()
    const result = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await result).toBe('teardown-unconfirmed')
    expect(mocks.exec.mock.calls[0][2].signal.aborted).toBe(true)
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(mocks.exec).toHaveBeenCalledOnce()
  })

  it('admits setup on a new connection generation after an unconfirmed teardown', async () => {
    const conn = connection()
    const generation = vi.spyOn(conn, 'getConnectGeneration')
    mocks.exec.mockRejectedValueOnce(
      Object.assign(new Error('Channel teardown is unconfirmed'), {
        sshChannelCloseConfirmed: false
      })
    )
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(mocks.exec).toHaveBeenCalledOnce()
    generation.mockReturnValue(2)
    mocks.exec.mockResolvedValueOnce(frame('ready', '/usr/bin/node'))
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe('ready')
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it.each(['ready', 'not-needed'] as const)(
    'refuses a late %s result from a superseded setup',
    async (status) => {
      const conn = connection()
      const generation = vi.spyOn(conn, 'getConnectGeneration')
      mocks.exec.mockImplementationOnce(async () => {
        generation.mockReturnValue(2)
        return frame(status, '/usr/bin/node')
      })
      expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe('failed')
      expect(mocks.exec).toHaveBeenCalledOnce()
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )

  it.each(['publication', 'cleanup'] as const)(
    'refuses completed setup when its generation changes during %s',
    async (stage) => {
      const conn = connection()
      const generation = vi.spyOn(conn, 'getConnectGeneration')
      const started = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<string>()
      mocks.exec.mockImplementation(async (_conn, command: string) => {
        if (command.includes('SELECT 1 AS ready')) {
          return frame('ready', '/usr/bin/node')
        }
        const selected =
          stage === 'publication'
            ? command.includes('published')
            : command.includes('claim_identity') && !command.includes('old=')
        if (selected) {
          started.resolve()
          return finish.promise
        }
        return hostCommandResult(command)
      })
      const pending = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
      await started.promise
      generation.mockReturnValue(2)
      finish.resolve(stage === 'publication' ? frame('published') : '')

      expect(await pending).toBe('failed')
      expect(mocks.exec).toHaveBeenCalledTimes(stage === 'publication' ? 4 : 5)
      expect(mocks.write).toHaveBeenCalledOnce()
    }
  )

  it('keeps a newer setup registered when the superseded setup finishes late', async () => {
    const conn = connection()
    const generation = vi.spyOn(conn, 'getConnectGeneration')
    const oldProbe = Promise.withResolvers<string>()
    const currentProbe = Promise.withResolvers<string>()
    mocks.exec.mockReturnValueOnce(oldProbe.promise).mockReturnValueOnce(currentProbe.promise)
    const oldSetup = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    generation.mockReturnValue(2)
    const currentSetup = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    oldProbe.resolve(frame('not-needed'))
    expect(await oldSetup).toBe('failed')

    const joined = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    expect(mocks.exec).toHaveBeenCalledTimes(2)
    currentProbe.resolve(frame('not-needed'))
    expect(await Promise.all([currentSetup, joined])).toEqual(['not-needed', 'not-needed'])
  })

  it.each(['deadline', 'caller'] as const)(
    'allows retry after local download cancellation by %s without reserving a stage',
    async (cause) => {
      const controller = new AbortController()
      let finish!: (path: string) => void
      mocks.materialize.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          finish = resolve
        })
      )
      if (cause === 'deadline') {
        vi.useFakeTimers()
      }
      const conn = connection()
      const pending = ensureRemoteOpenCodeRuntime(conn, host, remoteHome, {
        ...options(),
        signal: controller.signal
      })
      await vi.waitFor(() => expect(mocks.materialize).toHaveBeenCalledOnce())
      expect(mocks.exec).toHaveBeenCalledTimes(2)
      if (cause === 'deadline') {
        await vi.advanceTimersByTimeAsync(180_000)
      } else {
        controller.abort()
      }
      expect(await pending).toBe('failed')
      finish(runtime)
      vi.useRealTimers()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(mocks.exec).toHaveBeenCalledTimes(2)
      expect(mocks.upload).not.toHaveBeenCalled()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe('ready')
      expect(mocks.upload).toHaveBeenCalledOnce()
    }
  )

  it('retains the upload stage when a failed transfer may still be running', async () => {
    mocks.upload.mockRejectedValue(
      Object.assign(new Error('Upload teardown is unconfirmed'), {
        sshChannelCloseConfirmed: false
      })
    )
    const conn = connection()
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(mocks.exec).toHaveBeenCalledTimes(3)
    expect(mocks.exec.mock.calls.some(([, command]) => command.startsWith('rm -rf'))).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(mocks.exec).toHaveBeenCalledTimes(3)
  })

  it('reports an unconfirmed stage cleanup to the deployment command queue', async () => {
    mocks.exec.mockResolvedValueOnce(frame('ready', '/usr/bin/node'))
    mocks.cleanupError = true
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'teardown-unconfirmed'
    )
    expect(mocks.exec).toHaveBeenCalledTimes(5)
  })

  it('skips installation without data and retries when a database appears on the same connection', async () => {
    const conn = connection()
    mocks.exec.mockResolvedValueOnce(frame('not-needed'))
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe('not-needed')
    expect(mocks.exec).toHaveBeenCalledOnce()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(await ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())).toBe('ready')
    expect(mocks.upload).toHaveBeenCalledOnce()
  })

  it('fails optionally without publishing when all bounded stages are occupied', async () => {
    mocks.reservationError = true
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'failed'
    )
    // Includes the store-lock round trips (mkdir, acquire, re-probe, release) around promotion.
    expect(mocks.exec).toHaveBeenCalledTimes(11)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not mistake an unanswered Node probe for an old runtime', async () => {
    mocks.exec.mockResolvedValue('login banner only')
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(
      'failed'
    )
    expect(mocks.materialize).not.toHaveBeenCalled()
  })
})

describe('SSH OpenCode runtime setup on a Windows host', () => {
  const windows = getRemoteHostPlatform('win32-x64')
  const home = 'C:/Users/ada'
  const windowsRelayDir = `${home}/.orca-remote/relay-build`
  const sha = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
  const storeNode = `${home}/.orca-remote/runtimes/node-${sha}/node.exe`

  function answerWindows(storeReady: boolean): string[] {
    const scripts: string[] = []
    mocks.target.mockResolvedValue({ target: 'win32-x64', glibc: null })
    mocks.exec.mockImplementation(async (_conn, command: string) => {
      const script = decodeRemotePowerShellScript(command)
      scripts.push(script)
      if (script.includes('SELECT 1 AS ready')) {
        return frame('unsupported')
      }
      if (script.includes('.store-lock') && script.includes('CreateNew')) {
        return 'OK'
      }
      if (script.includes('Invoke-OrcaPromote')) {
        return 'ORCA_NODE_RUNTIME_READY'
      }
      if (script.includes('ORCA_NODE_RUNTIME_MISSING')) {
        return storeReady ? 'ORCA_NODE_RUNTIME_READY' : 'ORCA_NODE_RUNTIME_MISSING'
      }
      if (script.includes('staging quota is full')) {
        return `__ORCA_UPLOAD_STAGE_SLOT__${script.match(/\.sftp-namespace-[0-9a-f]{32}/)?.[0]}:slot-0`
      }
      if (script.includes('COPYFILE_EXCL')) {
        return frame('published')
      }
      return ''
    })
    return scripts
  }

  it('installs the official archive through the runtime store, not a client-extracted node.exe', async () => {
    const scripts = answerWindows(false)
    expect(
      await ensureRemoteOpenCodeRuntime(connection(true), windows, home, {
        nodePath: 'C:/Program Files/nodejs/node.exe',
        relayDir: windowsRelayDir,
        cacheRoot
      })
    ).toBe('ready')
    expect(mocks.materialize).toHaveBeenCalledWith('win32-x64', cacheRoot, expect.any(Object))
    expect(mocks.upload).toHaveBeenCalledOnce()
    expect(mocks.upload.mock.calls[0][2]).toMatch(
      /\/runtimes\/\.stage-node-[0-9a-f]{64}-[0-9a-f]{16}$/
    )
    expect(scripts.some((script) => script.includes('Invoke-OrcaPromote'))).toBe(true)
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({ protocol: 1, executable: storeNode })
    const publish = scripts.find((script) => script.includes('COPYFILE_EXCL'))
    expect(publish).toContain(`${windowsRelayDir}/.runtime-ref-node-${sha}`)
    // Stage fencing reads file IDs through the verified node.exe, so no script compiles C#.
    const stageScripts = scripts.filter((script) => script.includes('$getFileIdentity'))
    expect(stageScripts.length).toBeGreaterThan(0)
    for (const script of stageScripts) {
      expect(script).toContain(`$orcaIdentityNode = '${storeNode}'`)
      expect(script).not.toContain('Add-Type')
    }
  })

  it("reuses a verified store runtime and prefers the relay's own verified node.exe", async () => {
    const scripts = answerWindows(true)
    const relayNode = `${home}/.orca-remote/runtimes/node-other/node.exe`
    expect(
      await ensureRemoteOpenCodeRuntime(connection(true), windows, home, {
        nodePath: relayNode,
        verifiedNodePath: relayNode,
        relayDir: windowsRelayDir,
        cacheRoot
      })
    ).toBe('ready')
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    for (const script of scripts.filter((s) => s.includes('$getFileIdentity'))) {
      expect(script).toContain(`$orcaIdentityNode = '${relayNode}'`)
    }
  })
})
