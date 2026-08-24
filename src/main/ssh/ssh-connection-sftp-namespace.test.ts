// Why: namespace resolution has to happen on the very session that transfers, and
// only for the two relay-install writes — a leak into other transfers or into the
// system-SSH/Windows branches would silently retarget unrelated file operations.

import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ssh2', () => ({
  BaseAgent: class {},
  Client: class {},
  createAgent: vi.fn(),
  utils: { parseKey: vi.fn() }
}))

vi.mock('./ssh-system-fallback', () => ({
  getOrcaControlSocketPath: vi.fn().mockReturnValue(null),
  spawnSystemSsh: vi.fn(),
  spawnSystemSshCommand: vi.fn(),
  downloadFileViaSystemSsh: vi.fn().mockResolvedValue(undefined),
  uploadDirectoryViaSystemSsh: vi.fn().mockResolvedValue(undefined),
  uploadFileViaSystemSsh: vi.fn().mockResolvedValue(undefined),
  writeBufferViaSystemSsh: vi.fn().mockResolvedValue(undefined),
  writeFileViaSystemSsh: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-control-socket', () => ({ removeControlSocketPath: vi.fn() }))
vi.mock('./ssh-config-parser', () => ({ resolveWithSshG: vi.fn().mockResolvedValue(null) }))

import { SshConnection } from './ssh-connection'
import type { SftpNamespacePathMapping } from './sftp-namespace-resolution'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { uploadDirectoryViaSystemSsh, writeFileViaSystemSsh } from './ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'

const SHELL_HOME = '/var/services/homes/alice'
const SFTP_HOME = '/homes/alice'
const RELAY_DIR = '.orca-remote/relay-0.1.0+hash'
const MARKER = '.install-lock/.sftp-namespace-cafebabe'
const SHELL_RELAY_DIR = `${SHELL_HOME}/${RELAY_DIR}`

const namespace: SftpNamespacePathMapping = {
  homeRelativeNamespaceRoot: RELAY_DIR,
  homeRelativePath: RELAY_DIR,
  shellProbePath: `${SHELL_RELAY_DIR}/${MARKER}`,
  homeRelativeProbePath: `${RELAY_DIR}/${MARKER}`
}

function fileNamespace(fileName: string): SftpNamespacePathMapping {
  return { ...namespace, homeRelativePath: `${RELAY_DIR}/${fileName}` }
}

type FakeSftp = EventEmitter & {
  realpathCalls: string[]
  lstatCalls: string[]
  writtenPaths: string[]
  mkdirPaths: string[]
  endCalls: number
  emitCloseOnEnd: boolean
  pendingRealpathCallbacks: RealpathCallback[]
  pendingLstatCallbacks: LstatCallback[]
  realpath: ReturnType<typeof vi.fn>
  lstat: ReturnType<typeof vi.fn>
  mkdir: ReturnType<typeof vi.fn>
  createWriteStream: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

type RealpathCallback = (err: Error | null, resolved?: string) => void
type LstatCallback = (err: Error | null) => void

function createFakeSftp(options?: { pendingRealpath?: boolean; pendingLstat?: boolean }): FakeSftp {
  const sftp = new EventEmitter() as FakeSftp
  sftp.realpathCalls = []
  sftp.lstatCalls = []
  sftp.writtenPaths = []
  sftp.mkdirPaths = []
  sftp.endCalls = 0
  sftp.emitCloseOnEnd = true
  sftp.pendingRealpathCallbacks = []
  sftp.pendingLstatCallbacks = []
  sftp.realpath = vi.fn((path: string, cb: RealpathCallback) => {
    sftp.realpathCalls.push(path)
    if (options?.pendingRealpath) {
      sftp.pendingRealpathCallbacks.push(cb)
      return
    }
    cb(null, SFTP_HOME)
  })
  // The install-owner marker exists only under the SFTP start directory.
  sftp.lstat = vi.fn((path: string, cb: LstatCallback) => {
    sftp.lstatCalls.push(path)
    if (options?.pendingLstat) {
      sftp.pendingLstatCallbacks.push(cb)
      return
    }
    if (path === `${SFTP_HOME}/${RELAY_DIR}/${MARKER}`) {
      cb(null)
      return
    }
    cb(Object.assign(new Error('No such file'), { code: 2 }))
  })
  sftp.mkdir = vi.fn((path: string, cb: (err: Error | null) => void) => {
    sftp.mkdirPaths.push(path)
    cb(null)
  })
  sftp.createWriteStream = vi.fn((path: string) => {
    sftp.writtenPaths.push(path)
    const ws = new EventEmitter()
    return Object.assign(ws, {
      end: vi.fn(() => setTimeout(() => ws.emit('close'), 0)),
      destroy: vi.fn(),
      off: ws.removeListener.bind(ws),
      write: vi.fn(),
      on: ws.on.bind(ws)
    })
  })
  sftp.end = vi.fn(() => {
    sftp.endCalls += 1
    if (sftp.emitCloseOnEnd) {
      setTimeout(() => sftp.emit('close'), 0)
    }
  })
  return sftp
}

function createTarget(): SshTarget {
  return {
    id: 'target-1',
    label: 'Synology',
    host: 'nas.local',
    port: 22,
    username: 'alice',
    authMethod: 'agent'
  } as SshTarget
}

function connectedTo(
  sftpSessions: FakeSftp[],
  options?: { sftpError?: Error; useSystemSsh?: boolean }
): SshConnection {
  const conn = new SshConnection(createTarget(), {
    onStateChange: vi.fn(),
    onLog: vi.fn()
  } as never)
  let handed = 0
  const client = {
    sftp: (cb: (err: Error | undefined, sftp: unknown) => void) => {
      if (options?.sftpError) {
        cb(options.sftpError, undefined)
        return
      }
      cb(undefined, sftpSessions[handed++] ?? sftpSessions.at(-1))
    }
  }
  // Why: the transfer branches are the unit under test; skip the connect handshake.
  Object.assign(conn as unknown as Record<string, unknown>, {
    client,
    useSystemSshTransport: options?.useSystemSsh ?? false
  })
  return conn
}

describe('SshConnection SFTP namespace resolution', () => {
  const linux = getRemoteHostPlatform('linux-x64')
  const windows = getRemoteHostPlatform('win32-x64')
  let localDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // realpath: macOS /var is a symlink and uploadDirectory rejects a root that resolves elsewhere.
    localDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-')))
    writeFileSync(join(localDir, 'relay.js'), 'console.log(1)')
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
  })

  it('writes to the SFTP namespace path discovered on the same session', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp])

    await conn.writeFile(`${SHELL_RELAY_DIR}/.version`, '0.1.0+hash', {
      hostPlatform: linux,
      sftpNamespace: fileNamespace('.version')
    })

    expect(sftp.realpathCalls).toEqual(['.'])
    expect(sftp.writtenPaths).toEqual([`${SFTP_HOME}/${RELAY_DIR}/.version`])
    expect(sftp.endCalls).toBe(1)
  })

  it('uploads the bundle into the SFTP namespace directory', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp])

    await conn.uploadDirectory(localDir, SHELL_RELAY_DIR, {
      hostPlatform: linux,
      sftpNamespace: namespace
    })

    expect(sftp.writtenPaths).toEqual([`${SFTP_HOME}/${RELAY_DIR}/relay.js`])
    expect(sftp.endCalls).toBe(1)
  })

  it('issues no discovery requests when the caller supplies no mapping', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp])

    await conn.writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', { hostPlatform: linux })

    expect(sftp.realpathCalls).toEqual([])
    expect(sftp.lstatCalls).toEqual([])
    expect(sftp.writtenPaths).toEqual([`${SHELL_RELAY_DIR}/.version`])
  })

  it('ignores a mapping on a Windows host', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp])

    await conn.writeFile('C:\\Users\\alice\\relay\\.version', 'v', {
      hostPlatform: windows,
      sftpNamespace: fileNamespace('.version')
    })

    expect(sftp.realpathCalls).toEqual([])
    expect(sftp.writtenPaths).toEqual(['C:\\Users\\alice\\relay\\.version'])
  })

  it('never resolves on the system-SSH transport', async () => {
    const conn = connectedTo([], { useSystemSsh: true })

    await conn.writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
      hostPlatform: linux,
      sftpNamespace: fileNamespace('.version')
    })
    await conn.uploadDirectory(localDir, SHELL_RELAY_DIR, {
      hostPlatform: linux,
      sftpNamespace: namespace
    })

    expect(vi.mocked(writeFileViaSystemSsh)).toHaveBeenCalledWith(
      expect.anything(),
      `${SHELL_RELAY_DIR}/.version`,
      'v',
      expect.anything()
    )
    expect(vi.mocked(uploadDirectoryViaSystemSsh)).toHaveBeenCalledWith(
      expect.anything(),
      localDir,
      SHELL_RELAY_DIR,
      expect.anything()
    )
  })

  // Why: only the relay-install writes carry a marker; other transfers have no owner to verify.
  it('leaves writeBuffer and openFileUploadSession on the shell path', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp, sftp])

    await conn.writeBuffer(`${SHELL_RELAY_DIR}/blob.bin`, Buffer.from('x'), {
      hostPlatform: linux,
      sftpNamespace: fileNamespace('blob.bin')
    })
    const session = await conn.openFileUploadSession({
      hostPlatform: linux,
      sftpNamespace: namespace
    })
    session.close()

    expect(sftp.realpathCalls).toEqual([])
    expect(sftp.writtenPaths).toEqual([`${SHELL_RELAY_DIR}/blob.bin`])
  })

  it('keeps the shell path when discovery is inconclusive', async () => {
    const sftp = createFakeSftp()
    sftp.lstat = vi.fn((path: string, cb: (err: Error | null) => void) => {
      sftp.lstatCalls.push(path)
      cb(Object.assign(new Error('permission denied'), { code: 3 }))
    })
    const conn = connectedTo([sftp])

    await conn.writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
      hostPlatform: linux,
      sftpNamespace: fileNamespace('.version')
    })

    expect(sftp.writtenPaths).toEqual([`${SHELL_RELAY_DIR}/.version`])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retaining shell path'))
  })

  it('aborts a transfer stuck in discovery and reports a confirmed channel close', async () => {
    vi.useFakeTimers()
    try {
      const sftp = createFakeSftp({ pendingRealpath: true })
      const conn = connectedTo([sftp])
      const controller = new AbortController()

      const write = conn
        .writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
          hostPlatform: linux,
          sftpNamespace: fileNamespace('.version'),
          signal: controller.signal
        })
        .catch((err: Error) => err)
      await vi.waitFor(() => expect(sftp.realpathCalls).toHaveLength(1))
      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      const error = (await write) as Error & {
        sshChannelCloseConfirmed?: boolean
      }
      expect(error.name).toBe('AbortError')
      expect(error.sshChannelCloseConfirmed).toBe(true)
      expect(sftp.endCalls).toBe(1)
      expect(sftp.writtenPaths).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an unconfirmed close when the aborted session never closes', async () => {
    vi.useFakeTimers()
    try {
      const sftp = createFakeSftp({ pendingRealpath: true })
      sftp.emitCloseOnEnd = false
      const conn = connectedTo([sftp])
      const controller = new AbortController()

      const write = conn
        .writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
          hostPlatform: linux,
          sftpNamespace: fileNamespace('.version'),
          signal: controller.signal
        })
        .catch((err: Error) => err)
      await vi.waitFor(() => expect(sftp.realpathCalls).toHaveLength(1))
      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      const error = (await write) as Error & { sshChannelCloseConfirmed?: boolean }
      expect(error.name).toBe('AbortError')
      expect(error.sshChannelCloseConfirmed).toBe(false)
      expect(sftp.endCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: relay deploy classifies MaxSessions to back off; wrapping it would hide the retry signal.
  it('preserves a session-limit channel-open error unchanged', async () => {
    const original = Object.assign(
      new Error('Channel open failure: open failed reason 4: MaxSessions'),
      { reason: 4 }
    )
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp], {
      sftpError: original
    })

    const error = await conn
      .writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
        hostPlatform: linux,
        sftpNamespace: fileNamespace('.version')
      })
      .catch((err: Error) => err)

    expect(error).toBe(original)
    expect(isSshSessionLimitError(error)).toBe(true)
    expect(sftp.realpathCalls).toEqual([])
    expect(sftp.writtenPaths).toEqual([])
  })

  it.each([
    ['succeeds', (callback: RealpathCallback) => callback(null, SFTP_HOME)],
    ['rejects', (callback: RealpathCallback) => callback(new Error('late REALPATH failure'))]
  ])(
    'ignores a late REALPATH callback that %s after a confirmed abort',
    async (_outcome, completeRealpath) => {
      const sftp = createFakeSftp({ pendingRealpath: true })
      const conn = connectedTo([sftp])
      const controller = new AbortController()
      const unhandledRejection = vi.fn()
      process.on('unhandledRejection', unhandledRejection)
      try {
        const write = conn
          .writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
            hostPlatform: linux,
            sftpNamespace: fileNamespace('.version'),
            signal: controller.signal
          })
          .catch((err: Error) => err)
        await vi.waitFor(() => expect(sftp.pendingRealpathCallbacks).toHaveLength(1))
        vi.useFakeTimers()
        controller.abort()
        await vi.advanceTimersByTimeAsync(5_000)

        const error = (await write) as Error & { sshChannelCloseConfirmed?: boolean }
        expect(error).toMatchObject({
          name: 'AbortError',
          sshChannelCloseConfirmed: true
        })

        completeRealpath(sftp.pendingRealpathCallbacks[0]!)
        await Promise.resolve()
        await Promise.resolve()

        expect(unhandledRejection).not.toHaveBeenCalled()
        expect(sftp.writtenPaths).toEqual([])
        expect(sftp.endCalls).toBe(1)
      } finally {
        process.off('unhandledRejection', unhandledRejection)
        vi.useRealTimers()
      }
    }
  )

  it.each([
    ['succeeds', (callback: LstatCallback) => callback(null)],
    [
      'rejects',
      (callback: LstatCallback) =>
        callback(Object.assign(new Error('late LSTAT failure'), { code: 3 }))
    ]
  ])(
    'ignores a late LSTAT callback that %s after an unconfirmed abort',
    async (_outcome, completeLstat) => {
      vi.useFakeTimers()
      const unhandledRejection = vi.fn()
      process.on('unhandledRejection', unhandledRejection)
      try {
        const sftp = createFakeSftp({ pendingLstat: true })
        sftp.emitCloseOnEnd = false
        const conn = connectedTo([sftp])
        const controller = new AbortController()
        const write = conn
          .writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
            hostPlatform: linux,
            sftpNamespace: fileNamespace('.version'),
            signal: controller.signal
          })
          .catch((err: Error) => err)
        await vi.waitFor(() => expect(sftp.pendingLstatCallbacks).toHaveLength(1))
        controller.abort()
        await vi.advanceTimersByTimeAsync(5_000)

        const error = (await write) as Error & { sshChannelCloseConfirmed?: boolean }
        expect(error).toMatchObject({
          name: 'AbortError',
          sshChannelCloseConfirmed: false
        })

        completeLstat(sftp.pendingLstatCallbacks[0]!)
        await Promise.resolve()
        await Promise.resolve()

        expect(unhandledRejection).not.toHaveBeenCalled()
        expect(sftp.writtenPaths).toEqual([])
        expect(sftp.endCalls).toBe(1)
      } finally {
        process.off('unhandledRejection', unhandledRejection)
        vi.useRealTimers()
      }
    }
  )

  it('swallows a late session error after the transfer settled', async () => {
    const sftp = createFakeSftp()
    const conn = connectedTo([sftp])

    await conn.writeFile(`${SHELL_RELAY_DIR}/.version`, 'v', {
      hostPlatform: linux,
      sftpNamespace: fileNamespace('.version')
    })

    expect(() => sftp.emit('error', new Error('late channel reset'))).not.toThrow()
  })
})
