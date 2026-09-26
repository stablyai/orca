import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SftpTransfer from './system-ssh-sftp-transfer'
import type { SshTarget } from '../../shared/ssh-types'

const { spawnMock, sftpMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), sftpMock: vi.fn() }))
vi.mock('./system-ssh-command', () => ({ spawnSystemSshCommand: spawnMock }))
vi.mock('./system-ssh-sftp-transfer', async (importActual) => ({
  ...(await importActual<typeof SftpTransfer>()),
  runSftpBatch: sftpMock
}))

import { SftpSubsystemUnavailableError } from './system-ssh-sftp-transfer'
import { clearWindowsRemoteWriteCapabilitiesForTests } from './system-ssh-windows-write-capabilities'
import {
  writeWindowsRemoteFile,
  type WindowsWriteSource
} from './system-ssh-windows-write-strategy'

const target = { id: 'win', host: 'windows.example', username: 'dev', port: 22 } as SshTarget
const payload = Buffer.from('private clipboard image')
const events: string[] = []
const commands: { script: string; bytes: Buffer }[] = []
let failPrivateCreate = false
let failPublish = false
let refusePwsh = false

function source(): WindowsWriteSource {
  return {
    totalBytes: payload.length,
    readChunk: async (offset, length) => payload.subarray(offset, offset + length),
    withLocalFile: (send) => send('/private/local/payload.png')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearWindowsRemoteWriteCapabilitiesForTests()
  events.length = 0
  commands.length = 0
  failPrivateCreate = false
  failPublish = false
  refusePwsh = false
  sftpMock.mockImplementation(async () => {
    events.push('sftp')
  })
  spawnMock.mockImplementation((_target, command: string) => {
    const encoded = /-EncodedCommand (\S+)/.exec(command)?.[1]
    const script = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command
    const privateCreate = script.includes('FileSecurity')
    const publish = script.includes('::Move($staging, $path)')
    const kind = privateCreate
      ? 'private-create'
      : publish
        ? 'publish'
        : script.includes('OpenStandardInput')
          ? 'stdin'
          : 'discard'
    events.push(kind)
    const record = { script, bytes: Buffer.alloc(0) }
    commands.push(record)
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    const channel = Object.assign(new EventEmitter(), { stdin, stderr, close: vi.fn() })
    stdin.on('data', (chunk: Buffer) => {
      record.bytes = Buffer.concat([record.bytes, chunk])
    })
    stdin.on('finish', () =>
      queueMicrotask(() => {
        const unavailablePwsh = refusePwsh && command.startsWith('pwsh.exe')
        if (unavailablePwsh) {
          stderr.write('pwsh.exe is not recognized as an internal or external command')
        }
        channel.emit(
          'close',
          (failPrivateCreate && privateCreate) || (failPublish && publish) || unavailablePwsh
            ? 1
            : 0
        )
      })
    )
    return channel
  })
})

const privateOptions = { exclusive: true, mode: 0o600 }

describe('private Windows staged writes', () => {
  it('establishes owner-only ACL before SFTP and publishes the same file by exclusive rename', async () => {
    await writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), privateOptions)
    expect(events).toEqual(['private-create', 'sftp', 'publish'])
    const create = commands[0]!.script
    expect(create).toContain('$security.SetAccessRuleProtection($true,$false)')
    expect(create).toContain('$security.SetOwner($identity)')
    expect(create).toContain('[System.IO.FileMode]::CreateNew')
    expect(create).toContain('[System.IO.FileOptions]::None,$security)')
    const staging = /\$path = '([^']+)'/.exec(create)![1]!
    expect(sftpMock.mock.calls[0]![1].join('\n')).toContain(staging.replace('C:/', '/C:/'))
    expect(commands[1]!.script).toContain(`$staging = '${staging}'`)
    expect(commands[1]!.script).toContain('[System.IO.File]::Move($staging, $path)')
    expect(commands[1]!.script).not.toContain('::Replace')
    expect(commands.every(({ bytes }) => bytes.length === 0)).toBe(true)
  })

  it.each([false, true])(
    'protects the stdin fallback before payload (PowerShell 5.1 fallback: %s)',
    async (fallback) => {
      refusePwsh = fallback
      sftpMock.mockImplementation(async () => {
        events.push('sftp')
        throw new SftpSubsystemUnavailableError('subsystem request failed')
      })
      await writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), privateOptions)
      expect(events.slice(0, 5)).toEqual([
        'private-create',
        'sftp',
        'discard',
        'private-create',
        'stdin'
      ])
      const creation = commands.findLast(({ script }) => script.includes('FileSecurity'))!
      const staging = /\$path = '([^']+)'/.exec(creation.script)![1]!
      const writes = commands.filter(({ script }) => script.includes('OpenStandardInput'))
      expect(writes).toHaveLength(fallback ? 2 : 1)
      for (const write of writes) {
        expect(write.script).toContain(`$path = '${staging}'`)
        expect(write.script).toContain(
          '[System.IO.File]::Open($path, [System.IO.FileMode]::Create,'
        )
        expect(write.bytes).toEqual(payload)
        expect(write.script).not.toContain('::Delete')
      }
      expect(events.at(-1)).toBe('publish')
    }
  )

  it('fails closed when private creation fails without attempting any payload transport', async () => {
    failPrivateCreate = true
    await expect(
      writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), privateOptions)
    ).rejects.toThrow('Failed to create private Windows staging file')
    expect(events).toEqual(['private-create', 'discard'])
    expect(sftpMock).not.toHaveBeenCalled()
    expect(commands.every(({ bytes }) => bytes.length === 0)).toBe(true)
  })

  it('cleans up a private staged file after an exclusive publish conflict', async () => {
    failPublish = true
    await expect(
      writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), privateOptions)
    ).rejects.toThrow('publish')
    expect(events).toEqual(['private-create', 'sftp', 'publish', 'discard'])
    expect(commands[1]!.script).not.toContain('::Delete($path)')
  })

  it.each([{ append: true, exclusive: true }, { exclusive: false }, {}])(
    'rejects unsupported private write combinations before staging: %j',
    async (options) => {
      await expect(
        writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), {
          ...options,
          mode: 0o600
        })
      ).rejects.toThrow('Private Windows writes require exclusive creation without append')
      expect(events).toEqual([])
    }
  )

  it('leaves ordinary SFTP writes unchanged', async () => {
    await writeWindowsRemoteFile(target, 'C:/Users/dev/image.png', source(), { exclusive: true })
    expect(events).toEqual(['sftp', 'publish'])
  })
})
