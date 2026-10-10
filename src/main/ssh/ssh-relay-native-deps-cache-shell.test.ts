// The cache's safety argument is made of `sh`, not TypeScript: `mkdir` elects the publisher,
// `.deps-complete` gates linking, and a failed publish must put the tree back. Asserting on the
// command strings cannot show any of that, so these run the real scripts against a real tree.

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  lstatSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  computeRelayNativeDepsCacheKey,
  relayNativeDepsCacheEntryDir,
  relayNativeDepsCacheNodeModulesPath
} from './ssh-relay-native-deps-cache'
import {
  ensureRelayNativeDepsCacheCommand,
  listRelayNativeDepsCacheEntriesCommand,
  listRelayNativeDepsCacheReferencesCommand,
  promoteRelayNativeDepsCacheCommand,
  RELAY_NATIVE_CACHE_LINKED,
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_MISS,
  RELAY_NATIVE_CACHE_NOT_PROMOTED,
  RELAY_NATIVE_CACHE_PROMOTED,
  RELAY_NATIVE_CACHE_REFS_OK,
  RELAY_NATIVE_CACHE_SEEDED
} from './ssh-relay-native-deps-cache-commands'

const HOST = getRemoteHostPlatform('linux-x64')
const DEPS = { 'node-pty': '1.1.0', '@parcel/watcher': '2.5.6' } as const
const KEY = computeRelayNativeDepsCacheKey({ platform: 'linux-x64', deps: DEPS })

// Debian and Ubuntu point /bin/sh at dash, which is stricter than the bash-in-sh-mode that macOS
// ships; run against both when both exist so a bashism cannot pass here and fail on a host.
const SHELLS = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell))

describe.runIf(process.platform !== 'win32').each(SHELLS)(
  'relay native-deps cache shell scripts (%s)',
  (shell) => {
    let home: string

    const relayDir = (version: string): string => join(home, '.orca-remote', `relay-${version}`)

    function sh(command: string): string {
      return execFileSync(shell, ['-c', command], { encoding: 'utf-8' })
    }

    /** A relay directory holding its own installed tree, exactly as `npm install` leaves it. */
    function makePrivateInstall(version: string, deps: Record<string, string> = DEPS): string {
      const dir = relayDir(version)
      mkdirSync(join(dir, 'node_modules', 'node-pty', 'build'), { recursive: true })
      mkdirSync(join(dir, 'node_modules', '@parcel', 'watcher'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'node-pty', 'build', 'pty.node'), 'binary')
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }))
      return dir
    }

    function ensure(version: string): string {
      return sh(
        ensureRelayNativeDepsCacheCommand(
          { host: HOST, remoteHome: home, relayDir: relayDir(version), key: KEY },
          DEPS
        )
      ).trim()
    }

    function promote(version: string): string {
      return sh(
        promoteRelayNativeDepsCacheCommand({
          host: HOST,
          remoteHome: home,
          relayDir: relayDir(version),
          key: KEY
        })
      ).trim()
    }

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-relay-cache-'))
      mkdirSync(join(home, '.orca-remote'), { recursive: true })
    })

    afterEach(() => {
      rmSync(home, { recursive: true, force: true })
    })

    it('publishes a probe-verified tree and links the relay directory to it', () => {
      makePrivateInstall('0.1.0+aaa')

      expect(promote('0.1.0+aaa')).toBe(RELAY_NATIVE_CACHE_PROMOTED)

      const target = relayNativeDepsCacheNodeModulesPath(HOST, home, KEY)
      expect(readlinkSync(join(relayDir('0.1.0+aaa'), 'node_modules'))).toBe(target)
      expect(statSync(join(target, 'node-pty', 'build', 'pty.node')).isFile()).toBe(true)
      expect(
        existsSync(join(relayNativeDepsCacheEntryDir(HOST, home, KEY), '.deps-complete'))
      ).toBe(true)
    })

    it('links a second bundle to the published tree with no install of its own', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')

      // A different bundle: fresh directory, no node_modules, nothing installed.
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })
      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_LINKED)

      const linked = join(relayDir('0.1.0+bbb'), 'node_modules')
      expect(readlinkSync(linked)).toBe(relayNativeDepsCacheNodeModulesPath(HOST, home, KEY))
      expect(statSync(join(linked, 'node-pty', 'build', 'pty.node')).isFile()).toBe(true)
    })

    it('will not link an entry whose completion sentinel is absent', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')
      rmSync(join(relayNativeDepsCacheEntryDir(HOST, home, KEY), '.deps-complete'))

      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })
      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_MISS)
      expect(existsSync(join(relayDir('0.1.0+bbb'), 'node_modules'))).toBe(false)
    })

    it('seeds from a sibling install rather than recompiling once more', () => {
      makePrivateInstall('0.1.0+aaa')
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })

      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_SEEDED)

      const seeded = join(relayDir('0.1.0+bbb'), 'node_modules')
      expect(lstatSync(seeded).isSymbolicLink()).toBe(false)
      expect(statSync(join(seeded, 'node-pty', 'build', 'pty.node')).isFile()).toBe(true)
      // The source is untouched, so a relay running out of it is unaffected.
      expect(existsSync(join(relayDir('0.1.0+aaa'), 'node_modules', 'node-pty'))).toBe(true)
    })

    it('refuses to seed from a sibling pinned to different versions', () => {
      makePrivateInstall('0.1.0+aaa', { 'node-pty': '1.0.0', '@parcel/watcher': '2.5.6' })
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })

      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_MISS)
      expect(existsSync(join(relayDir('0.1.0+bbb'), 'node_modules'))).toBe(false)
    })

    it('refuses to seed from a sibling that had node-pty skipped', () => {
      makePrivateInstall('0.1.0+aaa')
      rmSync(join(relayDir('0.1.0+aaa'), 'node_modules', 'node-pty'), { recursive: true })
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })

      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_MISS)
    })

    it('leaves a directory that installed for itself alone', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')
      const own = makePrivateInstall('0.1.0+bbb')

      expect(ensure('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_MISS)
      expect(lstatSync(join(own, 'node_modules')).isSymbolicLink()).toBe(false)
    })

    it('elects exactly one publisher and leaves the loser its own tree', () => {
      makePrivateInstall('0.1.0+aaa')
      makePrivateInstall('0.1.0+bbb')

      expect(promote('0.1.0+aaa')).toBe(RELAY_NATIVE_CACHE_PROMOTED)
      expect(promote('0.1.0+bbb')).toBe(RELAY_NATIVE_CACHE_NOT_PROMOTED)

      // The loser must not have handed its tree to an entry it lost the race for.
      const loser = join(relayDir('0.1.0+bbb'), 'node_modules')
      expect(lstatSync(loser).isSymbolicLink()).toBe(false)
      expect(statSync(join(loser, 'node-pty', 'build', 'pty.node')).isFile()).toBe(true)
    })

    it('never republishes through a symlink it already holds', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')

      expect(promote('0.1.0+aaa')).toBe(RELAY_NATIVE_CACHE_NOT_PROMOTED)
      expect(statSync(join(relayDir('0.1.0+aaa'), 'node_modules', 'node-pty')).isDirectory()).toBe(
        true
      )
    })

    it('survives removing a linked relay directory without touching the shared tree', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })
      ensure('0.1.0+bbb')

      // Exactly what version GC does to an idle directory.
      sh(`rm -rf ${JSON.stringify(relayDir('0.1.0+bbb'))}`)

      const target = relayNativeDepsCacheNodeModulesPath(HOST, home, KEY)
      expect(statSync(join(target, 'node-pty', 'build', 'pty.node')).isFile()).toBe(true)
    })

    it('reports the published entry and every symlink that references it', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')

      const entries = sh(listRelayNativeDepsCacheEntriesCommand(HOST, home)).trim().split('\n')
      expect(entries).toEqual([`ENTRY ${KEY}`, RELAY_NATIVE_CACHE_LIST_OK])

      const refs = sh(listRelayNativeDepsCacheReferencesCommand(HOST, home)).trim().split('\n')
      expect(refs).toEqual([
        `REF ${relayNativeDepsCacheNodeModulesPath(HOST, home, KEY)}`,
        RELAY_NATIVE_CACHE_REFS_OK
      ])
    })

    it('reports a symlink no Orca version wrote, so GC can refuse the pass', () => {
      makePrivateInstall('0.1.0+aaa')
      promote('0.1.0+aaa')
      mkdirSync(relayDir('0.1.0+bbb'), { recursive: true })
      symlinkSync('../relay-0.1.0+aaa/node_modules', join(relayDir('0.1.0+bbb'), 'node_modules'))

      const refs = sh(listRelayNativeDepsCacheReferencesCommand(HOST, home)).trim().split('\n')
      expect(refs).toContain('REF ../relay-0.1.0+aaa/node_modules')
      expect(refs.at(-1)).toBe(RELAY_NATIVE_CACHE_REFS_OK)
    })

    it('answers cleanly on a host that has never installed anything', () => {
      expect(sh(listRelayNativeDepsCacheEntriesCommand(HOST, home)).trim()).toBe(
        RELAY_NATIVE_CACHE_LIST_OK
      )
      expect(sh(listRelayNativeDepsCacheReferencesCommand(HOST, home)).trim()).toBe(
        RELAY_NATIVE_CACHE_REFS_OK
      )
    })
  }
)
