import { createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRexLocalEndpoint, validateRexLocalEndpoint } from './rex-local-endpoint'

describe.skipIf(process.platform === 'win32')('Rex local endpoint', () => {
  it('accepts only private sockets, rejects symlinks, files, relative paths and broad permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-socket-test-'))
    const path = join(dir, 's')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await chmod(path, 0o600)
      await expect(validateRexLocalEndpoint(path)).resolves.toBe(
        join(await realpath(dirname(path)), 's')
      )
      await chmod(path, 0o660)
      await expect(validateRexLocalEndpoint(path)).rejects.toThrow('owner-only')
      await chmod(path, 0o600)
      const alias = join(dir, 'alias')
      await symlink(path, alias)
      await expect(validateRexLocalEndpoint(alias)).rejects.toThrow('owner-only')
      const file = join(dir, 'file')
      await writeFile(file, '', { mode: 0o600 })
      await expect(validateRexLocalEndpoint(file)).rejects.toThrow('owner-only')
      await expect(validateRexLocalEndpoint('localhost:8080')).rejects.toThrow('absolute')
      await expect(validateRexLocalEndpoint(join(dir, 'missing'))).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('rejects writable ancestors even if the socket and its parent are private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-parent-'))
    const parent = join(dir, 'private')
    const path = join(parent, 's')
    const server = createServer()
    try {
      await mkdir(parent, { mode: 0o700 })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await chmod(path, 0o600)
      await chmod(dir, 0o777)
      await expect(validateRexLocalEndpoint(path)).rejects.toThrow('trusted')
      await chmod(dir, 0o1777)
      await expect(validateRexLocalEndpoint(path)).resolves.toBe(
        join(await realpath(dirname(path)), 's')
      )
      const alias = join(dir, 'parent-alias')
      await symlink(parent, alias)
      await expect(validateRexLocalEndpoint(join(alias, 's'))).resolves.toBe(
        join(await realpath(dirname(path)), 's')
      )
      await chmod(parent, 0o770)
      await expect(validateRexLocalEndpoint(path)).rejects.toThrow('trusted')
    } finally {
      await chmod(dir, 0o700)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Rex native socket location', () => {
  it('matches verified macOS and Linux personal server defaults', () => {
    expect(defaultRexLocalEndpoint('darwin', '/home/test', {})).toBe(
      '/home/test/Library/Application Support/rex/server.sock'
    )
    expect(defaultRexLocalEndpoint('linux', '/home/test', {})).toBe(
      '/home/test/.local/state/rex/run/server.sock'
    )
    expect(
      defaultRexLocalEndpoint('linux', '/home/test', { XDG_RUNTIME_DIR: '/run/user/123' })
    ).toBe('/run/user/123/rex/server.sock')
    expect(
      defaultRexLocalEndpoint('linux', '/home/test', {
        XDG_RUNTIME_DIR: 'relative',
        XDG_STATE_HOME: '/state'
      })
    ).toBe('/state/rex/run/server.sock')
    expect(defaultRexLocalEndpoint('win32', '/home/test', {})).toBeNull()
  })
})
