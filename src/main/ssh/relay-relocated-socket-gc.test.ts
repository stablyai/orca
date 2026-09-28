import { once } from 'node:events'
import { createServer } from 'node:net'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { shellEscape } from './ssh-connection-utils'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { relayLivenessProbeCommand } from './ssh-remote-commands'
import {
  resolveShortRelaySocketDirCommand,
  shortRelayVersionSegment
} from './relay-socket-path-limit'

const host = getRemoteHostPlatform('linux-x64')
const shell = (script: string) => runProcess({ program: '/bin/sh', args: ['-c', script] })

describe.skipIf(process.platform === 'win32')('relocated relay socket GC', () => {
  it('retains an older relocated socket and exposes new sockets to older GC', async () => {
    const root = await mkdtemp('/tmp/orca-gc-')
    const install = join(root, 'relay-0.1.0+abc')
    const shortRoot = join(root, 'short')
    const segment = shortRelayVersionSegment('relay-0.1.0+abc')
    const socket = join(shortRoot, segment, 'relay-test.sock')
    const alias = join(install, 'relay-test.sock')
    const server = createServer()
    try {
      await mkdir(install)
      const prepare = resolveShortRelaySocketDirCommand(segment).replace(
        /^dir=.*$/m,
        `dir=${shellEscape(shortRoot)}`
      )
      expect((await shell(prepare)).code).toBe(0)
      server.listen(socket)
      await once(server, 'listening')
      const probe = relayLivenessProbeCommand(host, install).replace(
        /short="[^"]+";/,
        `short=${shellEscape(join(shortRoot, segment))};`
      )
      expect((await shell(probe)).stdout.trim()).toBe('ALIVE')
      await chmod(shortRoot, 0o000)
      try {
        expect((await shell(probe)).stdout.trim()).toBe('UNVERIFIABLE')
      } finally {
        await chmod(shortRoot, 0o700)
      }
      const publish = resolveShortRelaySocketDirCommand(segment, {
        sockName: 'relay-test.sock',
        originalPath: alias
      }).replace(/^dir=.*$/m, `dir=${shellEscape(shortRoot)}`)
      expect((await shell(publish)).code).toBe(0)
      expect((await shell(publish)).code).toBe(0)
      expect(await readlink(alias)).toBe(socket)
      // The old collector only checks the install directory with test -S.
      expect((await shell(`[ -S ${shellEscape(alias)} ]`)).code).toBe(0)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      expect((await shell(probe)).stdout.trim()).toBe('DEAD')
    } finally {
      server.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['file', 'directory', 'symlink'] as const)(
    'refuses an unrelated alias %s',
    async (kind) => {
      const root = await mkdtemp('/tmp/orca-gc-')
      try {
        const alias = join(root, 'alias')
        if (kind === 'file') {
          await writeFile(alias, 'keep')
        }
        if (kind === 'directory') {
          await mkdir(alias)
        }
        if (kind === 'symlink') {
          await symlink(join(root, 'unrelated'), alias)
        }
        const script = resolveShortRelaySocketDirCommand('relay-test', {
          sockName: 'relay-test.sock',
          originalPath: alias
        }).replace(/^dir=.*$/m, `dir=${shellEscape(join(root, 'short'))}`)
        expect((await shell(script)).code).not.toBe(0)
        if (kind === 'file') {
          expect(await readFile(alias, 'utf8')).toBe('keep')
        } else if (kind === 'directory') {
          expect(await readdir(alias)).toEqual([])
        } else {
          expect(await readlink(alias)).toBe(join(root, 'unrelated'))
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('does not classify a failed uid probe as dead', async () => {
    const script = relayLivenessProbeCommand(host, '/unused/relay-0.1.0+abc')
    expect((await shell(`id() { return 1; }; ${script}`)).stdout.trim()).toBe('UNVERIFIABLE')
  })
})
