import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Client, Server as Ssh2Server, utils, type Connection, type SFTPWrapper } from 'ssh2'
import { expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection } from './ssh-connection'
import type { SftpNamespacePathMapping } from './sftp-namespace-resolution'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SHELL_HOME = '/var/services/homes/alice'
const SFTP_HOME = '/homes/alice'
const RELAY_DIR = '.orca-remote/relay-0.1.0+wire'
const SHELL_RELAY_DIR = `${SHELL_HOME}/${RELAY_DIR}`
const SFTP_RELAY_DIR = `${SFTP_HOME}/${RELAY_DIR}`
const MARKER_FILE = `.sftp-namespace-${'a'.repeat(32)}`
const MARKER_PATH = `.install-lock/${MARKER_FILE}`
const SFTP_OPEN_WRITE = 2
const SFTP_STATUS_OK = 0
const SFTP_STATUS_NO_SUCH_FILE = 2
const SFTP_STATUS_FAILURE = 4

type SftpWireServer = {
  port: number
  operations: string[]
  close: () => Promise<void>
}

type OpenFile = Awaited<ReturnType<typeof open>>

function backingPath(backingRoot: string, remotePath: string): string | null {
  if (remotePath === SFTP_HOME) {
    return backingRoot
  }
  if (!remotePath.startsWith(`${SFTP_HOME}/`)) {
    return null
  }
  const relativePath = posix.relative(SFTP_HOME, remotePath)
  if (!relativePath || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
    return null
  }
  return join(backingRoot, ...relativePath.split('/'))
}

function sendFsError(sftp: SFTPWrapper, requestId: number, error: unknown): void {
  const code =
    error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? SFTP_STATUS_NO_SUCH_FILE
      : SFTP_STATUS_FAILURE
  sftp.status(requestId, code)
}

function fileId(handle: Buffer, files: Map<number, OpenFile>): number | null {
  if (handle.length !== 4) {
    return null
  }
  const id = handle.readUInt32BE(0)
  return files.has(id) ? id : null
}

function installSftpHandlers(sftp: SFTPWrapper, backingRoot: string, operations: string[]): void {
  const files = new Map<number, OpenFile>()
  let nextFileId = 0
  sftp.on('error', () => {})
  sftp.on('REALPATH', (requestId, remotePath) => {
    operations.push(`REALPATH:${remotePath}`)
    if (remotePath !== '.') {
      sftp.status(requestId, SFTP_STATUS_NO_SUCH_FILE)
      return
    }
    sftp.name(requestId, [
      {
        filename: SFTP_HOME,
        longname: SFTP_HOME,
        attrs: { mode: 0o40_755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }
      }
    ])
  })
  sftp.on('LSTAT', (requestId, remotePath) => {
    operations.push(`LSTAT:${remotePath}`)
    const localPath = backingPath(backingRoot, remotePath)
    if (!localPath) {
      sftp.status(requestId, SFTP_STATUS_NO_SUCH_FILE)
      return
    }
    void lstat(localPath).then(
      (stats) =>
        sftp.attrs(requestId, {
          mode: stats.mode,
          size: stats.size,
          uid: stats.uid,
          gid: stats.gid,
          atime: Math.floor(stats.atimeMs / 1000),
          mtime: Math.floor(stats.mtimeMs / 1000)
        }),
      (error: unknown) => sendFsError(sftp, requestId, error)
    )
  })
  sftp.on('MKDIR', (requestId, remotePath) => {
    operations.push(`MKDIR:${remotePath}`)
    const localPath = backingPath(backingRoot, remotePath)
    if (!localPath) {
      sftp.status(requestId, SFTP_STATUS_NO_SUCH_FILE)
      return
    }
    void mkdir(localPath).then(
      () => sftp.status(requestId, SFTP_STATUS_OK),
      (error: unknown) => sendFsError(sftp, requestId, error)
    )
  })
  sftp.on('OPEN', (requestId, remotePath, flags) => {
    operations.push(`OPEN:${remotePath}`)
    const localPath = backingPath(backingRoot, remotePath)
    if (!localPath || !(flags & SFTP_OPEN_WRITE)) {
      sftp.status(requestId, SFTP_STATUS_NO_SUCH_FILE)
      return
    }
    void open(localPath, 'w').then(
      (file) => {
        const id = nextFileId++
        files.set(id, file)
        const handle = Buffer.alloc(4)
        handle.writeUInt32BE(id)
        sftp.handle(requestId, handle)
      },
      (error: unknown) => sendFsError(sftp, requestId, error)
    )
  })
  sftp.on('WRITE', (requestId, handle, offset, data) => {
    operations.push('WRITE')
    const id = fileId(handle, files)
    if (id === null) {
      sftp.status(requestId, SFTP_STATUS_FAILURE)
      return
    }
    void files
      .get(id)!
      .write(data, 0, data.length, offset)
      .then(
        () => sftp.status(requestId, SFTP_STATUS_OK),
        (error: unknown) => sendFsError(sftp, requestId, error)
      )
  })
  sftp.on('CLOSE', (requestId, handle) => {
    operations.push('CLOSE')
    const id = fileId(handle, files)
    if (id === null) {
      sftp.status(requestId, SFTP_STATUS_FAILURE)
      return
    }
    const file = files.get(id)!
    files.delete(id)
    void file.close().then(
      () => sftp.status(requestId, SFTP_STATUS_OK),
      (error: unknown) => sendFsError(sftp, requestId, error)
    )
  })
}

async function startSftpWireServer(backingRoot: string): Promise<SftpWireServer> {
  const operations: string[] = []
  const connections = new Set<Connection>()
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Ssh2Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (context) => {
      if (
        context.method === 'password' &&
        context.username === 'fixture' &&
        context.password === 'secret'
      ) {
        context.accept()
      } else {
        context.reject()
      }
    })
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => {
          installSftpHandlers(acceptSftp(), backingRoot, operations)
        })
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('SSH fixture did not bind a TCP port')
  }
  return {
    port: address.port,
    operations,
    close: async () => {
      for (const connection of connections) {
        connection.end()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

function connectSshClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client))
    client.once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port,
      username: 'fixture',
      password: 'secret',
      hostVerifier: () => true,
      readyTimeout: 5_000
    })
  })
}

function connectionWithClient(client: Client): SshConnection {
  const target = {
    id: 'sftp-wire',
    label: 'SFTP wire fixture',
    host: '127.0.0.1',
    port: 22,
    username: 'fixture',
    authMethod: 'password'
  } as SshTarget
  const connection = new SshConnection(target, { onStateChange: vi.fn() })
  Object.assign(connection as unknown as Record<string, unknown>, {
    client,
    useSystemSshTransport: false
  })
  return connection
}

async function boundedTransfer(
  operation: Promise<void>,
  operations: string[],
  label: string
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`SFTP wire ${label} timed out: ${operations.join(', ')}`)),
          5_000
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function splitNamespaceMapping(homeRelativePath: string): SftpNamespacePathMapping {
  return {
    homeRelativePath,
    shellProbePath: `${SHELL_RELAY_DIR}/${MARKER_PATH}`,
    homeRelativeProbePath: `${RELAY_DIR}/${MARKER_PATH}`
  }
}

async function withSplitNamespaceFixture(
  run: (args: {
    connection: SshConnection
    fixture: SftpWireServer
    backingRelayDir: string
  }) => Promise<void>
): Promise<void> {
  const backingRoot = await mkdtemp(join(tmpdir(), 'orca-sftp-wire-remote-'))
  const backingRelayDir = join(backingRoot, ...RELAY_DIR.split('/'))
  await mkdir(join(backingRelayDir, '.install-lock'), { recursive: true })
  await writeFile(join(backingRelayDir, '.install-lock', MARKER_FILE), '')

  let fixture: SftpWireServer | undefined
  let client: Client | undefined
  try {
    fixture = await startSftpWireServer(backingRoot)
    client = await connectSshClient(fixture.port)
    await run({
      connection: connectionWithClient(client),
      fixture,
      backingRelayDir
    })
  } finally {
    client?.end()
    await fixture?.close()
    await rm(backingRoot, { recursive: true, force: true })
  }
}

it('uploads through a verified split namespace over a real ssh2 SFTP session', async () => {
  const localDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-sftp-wire-local-')))
  await mkdir(join(localDir, 'nested'))
  await writeFile(join(localDir, 'nested', 'payload.bin'), Buffer.from([0, 1, 2, 255]))

  try {
    await withSplitNamespaceFixture(async ({ connection, fixture, backingRelayDir }) => {
      const mapping = splitNamespaceMapping(RELAY_DIR)

      await boundedTransfer(
        connection.uploadDirectory(localDir, SHELL_RELAY_DIR, {
          hostPlatform: getRemoteHostPlatform('linux-x64'),
          sftpNamespace: mapping
        }),
        fixture.operations,
        'upload'
      )

      expect(await readFile(join(backingRelayDir, 'nested', 'payload.bin'))).toEqual(
        Buffer.from([0, 1, 2, 255])
      )
      expect(fixture.operations).toContain(`REALPATH:.`)
      expect(fixture.operations).toContain(`LSTAT:${mapping.shellProbePath}`)
      expect(fixture.operations).toContain(`LSTAT:${SFTP_RELAY_DIR}/${MARKER_PATH}`)
      expect(fixture.operations).toContain(`MKDIR:${SFTP_RELAY_DIR}/nested`)
      expect(fixture.operations).toContain(`OPEN:${SFTP_RELAY_DIR}/nested/payload.bin`)
      expect(fixture.operations).toEqual(expect.arrayContaining(['WRITE', 'CLOSE']))
    })
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
}, 15_000)

it('writes a mapped file through a verified split namespace over a real ssh2 SFTP session', async () => {
  await withSplitNamespaceFixture(async ({ connection, fixture, backingRelayDir }) => {
    const mapping = splitNamespaceMapping(`${RELAY_DIR}/package.json`)
    const shellFilePath = `${SHELL_RELAY_DIR}/package.json`
    const contents = '{"name":"orca-relay"}\n'

    await boundedTransfer(
      connection.writeFile(shellFilePath, contents, {
        hostPlatform: getRemoteHostPlatform('linux-x64'),
        sftpNamespace: mapping
      }),
      fixture.operations,
      'writeFile'
    )

    expect(await readFile(join(backingRelayDir, 'package.json'), 'utf8')).toBe(contents)
    expect(fixture.operations).toContain(`REALPATH:.`)
    expect(fixture.operations).toContain(`LSTAT:${mapping.shellProbePath}`)
    expect(fixture.operations).toContain(`LSTAT:${SFTP_RELAY_DIR}/${MARKER_PATH}`)
    expect(fixture.operations).toContain(`OPEN:${SFTP_RELAY_DIR}/package.json`)
    expect(fixture.operations).toEqual(expect.arrayContaining(['WRITE', 'CLOSE']))
    // Shell-namespace path must never be opened for a confirmed split write.
    expect(fixture.operations).not.toContain(`OPEN:${shellFilePath}`)
  })
}, 15_000)
