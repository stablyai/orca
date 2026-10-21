import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { uploadDirectoryIntoWsl, wslGuestSourcePath } from './wsl-directory-upload'
import { createWslOrcadHostTransport, type WslOrcadHostTransport } from './wsl-orcad-host-transport'

function hasSha256sum(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v sha256sum'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('wslGuestSourcePath', () => {
  const originalPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('maps a drive-letter directory onto its /mnt automount', () => {
    expect(wslGuestSourcePath('C:\\Users\\me\\orcad', 'Ubuntu')).toBe('/mnt/c/Users/me/orcad')
  })

  it('leaves a source with no drive letter to the tar stream', () => {
    expect(wslGuestSourcePath('/opt/orcad', 'Ubuntu')).toBeNull()
    expect(wslGuestSourcePath('\\\\server\\share\\orcad', 'Ubuntu')).toBeNull()
  })

  it('reads the same distro directly but not another distro', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    expect(wslGuestSourcePath('\\\\wsl.localhost\\ubuntu\\home\\me\\o', 'Ubuntu')).toBe(
      '/home/me/o'
    )
    expect(wslGuestSourcePath('\\\\wsl.localhost\\Debian\\home\\me\\o', 'Ubuntu')).toBeNull()
  })
})

// Runs the generated scripts through a real POSIX shell standing in for the distro.
describe.skipIf(process.platform === 'win32' || !hasSha256sum())('uploadDirectoryIntoWsl', () => {
  let root: string
  let source: string
  let dest: string
  let commands: string[]
  const transports: WslOrcadHostTransport[] = []
  const children: PipedChildProcess[] = []

  const getTransport = (): WslOrcadHostTransport => {
    const transport = transports.at(-1)
    if (!transport) {
      throw new Error('WSL test transport was not initialized')
    }
    return transport
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wsl-upload-'))
    source = join(root, 'source')
    dest = join(root, 'dest')
    commands = []
    const transport = createWslOrcadHostTransport({
      target: { kind: 'wsl', id: 'env-test', distro: 'test', label: 'test' },
      spawn: (spec) => {
        const args = spec.args ?? []
        const execIndex = args.indexOf('--exec')
        const command = args[execIndex + 3] ?? ''
        commands.push(command)
        const child = spawnProcess({
          program: 'sh',
          args: args.slice(execIndex + 2),
          stdio: 'pipe'
        })
        children.push(child)
        return child
      }
    })
    transports.push(transport)
    mkdirSync(join(source, 'bin'), { recursive: true })
    mkdirSync(join(source, 'empty'), { recursive: true })
    writeFileSync(join(source, 'bin', 'tool'), '#!/bin/sh\necho ran\n')
    chmodSync(join(source, 'bin', 'tool'), 0o755)
    writeFileSync(join(source, "it's here.txt"), 'quoted')
    writeFileSync(join(source, 'large.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 9))
  })

  afterEach(() => {
    transports.splice(0).forEach((transport) => transport.dispose())
    children.splice(0).forEach((child) => child.kill())
    rmSync(root, { recursive: true, force: true })
  })

  const expectUploaded = (): void => {
    expect(readFileSync(join(dest, 'bin', 'tool'), 'utf8')).toBe('#!/bin/sh\necho ran\n')
    expect(statSync(join(dest, 'bin', 'tool')).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(dest, "it's here.txt"), 'utf8')).toBe('quoted')
    expect(statSync(join(dest, 'large.bin')).size).toBe(3 * 1024 * 1024 + 7)
    expect(existsSync(join(dest, 'empty'))).toBe(true)
    expect(readdirSync(dest).filter((name) => name.startsWith('.orca-upload-'))).toEqual([])
  }

  it('streams a tar when the guest cannot see the source', async () => {
    await uploadDirectoryIntoWsl(getTransport(), source, null, dest)
    expectUploaded()
    expect(commands.some((command) => command.includes('tar -x'))).toBe(true)
  })

  it('copies from the guest-visible path without a tar stream', async () => {
    await uploadDirectoryIntoWsl(getTransport(), source, source, dest)
    expectUploaded()
    expect(commands.some((command) => command.includes('tar -x'))).toBe(false)
  })

  it('falls back to the tar stream when the mount is missing', async () => {
    await uploadDirectoryIntoWsl(getTransport(), source, join(root, 'not-mounted'), dest)
    expectUploaded()
    expect(commands.some((command) => command.includes('tar -x'))).toBe(true)
  })

  it('merges into an existing destination, replacing changed files', async () => {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'keep.txt'), 'kept')
    writeFileSync(join(dest, 'large.bin'), 'stale')
    await uploadDirectoryIntoWsl(getTransport(), source, null, dest)
    expectUploaded()
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('kept')
  })

  it('refuses a staged copy whose bytes differ from the Windows-side digests', async () => {
    const other = join(root, 'other')
    execFileSync('cp', ['-R', source, other])
    writeFileSync(join(other, 'large.bin'), 'tampered')
    await expect(uploadDirectoryIntoWsl(getTransport(), source, other, dest)).rejects.toThrow(
      /digest check/
    )
    expect(existsSync(join(dest, 'large.bin'))).toBe(false)
    expect(readdirSync(dest).filter((name) => name.startsWith('.orca-upload-'))).toEqual([])
  })

  it('writes a file atomically through stdin', async () => {
    await getTransport().writeFile(join(dest, 'nested', 'record.json'), '{"ok":true}')
    expect(readFileSync(join(dest, 'nested', 'record.json'), 'utf8')).toBe('{"ok":true}')
  })
})
