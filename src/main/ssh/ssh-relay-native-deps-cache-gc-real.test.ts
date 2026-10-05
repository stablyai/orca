import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execMock }))

import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { gcRelayNativeDepsCache } from './ssh-relay-native-deps-cache-gc'
import { listRelayNativeDepsCacheEntriesCommand } from './ssh-relay-native-deps-cache-commands'
import {
  relayNativeDepsCacheBaseDir,
  relayNativeDepsCacheEntryDir,
  LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
  RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
} from './ssh-relay-native-deps-cache'

const host = getRemoteHostPlatform('linux-x64')
const key = 'linux-x64-0123456789abcdef'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is replaced by a local shell for every connection access.
const conn = {} as SshConnection
const shells = ['/bin/sh', '/bin/dash'].filter(existsSync)

describe.runIf(process.platform !== 'win32').each(shells)(
  'native cache GC recovery (%s)',
  (shell) => {
    let home: string
    let cache: string
    let entry: string
    let relay: string

    function runShell(command: string): string {
      const result = runProcessSync({ program: shell, args: ['-c', command], timeoutMs: 15_000 })
      if (result.code !== 0) {
        throw new Error(result.stderr || `Shell exited ${result.code}`)
      }
      return result.stdout
    }

    function tombstone(
      timestamp = Date.now() - 60 * 60_000,
      prefix = RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
    ): string {
      const path = join(cache, `${prefix}${key}.123.${timestamp}`)
      renameSync(entry, path)
      return path
    }

    function referenceEntry(): void {
      symlinkSync(join(entry, 'node_modules'), join(relay, 'node_modules'))
    }

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca native gc '))
      cache = relayNativeDepsCacheBaseDir(host, home)
      entry = relayNativeDepsCacheEntryDir(host, home, key)
      relay = join(home, '.orca-remote', 'relay-0.1.0+abc')
      mkdirSync(relay, { recursive: true })
      mkdirSync(join(entry, 'node_modules'), { recursive: true })
      writeFileSync(join(entry, 'node_modules', 'addon.node'), 'original')
      writeFileSync(join(entry, '.deps-complete'), '')
      utimesSync(entry, new Date(0), new Date(0))
      execMock
        .mockReset()
        .mockImplementation(async (_conn: unknown, command: string) => runShell(command))
    })

    afterEach(() => {
      chmodSync(join(home, '.orca-remote'), 0o755)
      chmodSync(relay, 0o755)
      rmSync(home, { recursive: true, force: true })
    })

    function tombstones(): string[] {
      return readdirSync(cache).filter((name) =>
        name.startsWith(RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX)
      )
    }

    it('lists an ancient-mtime tombstone without deleting it and restores its live reference', async () => {
      referenceEntry()
      const path = tombstone()

      expect(runShell(listRelayNativeDepsCacheEntriesCommand(host, home))).toContain(
        `ENTRY ${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}`
      )
      expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)

      await gcRelayNativeDepsCache(conn, host, home)

      expect(readFileSync(join(relay, 'node_modules', 'addon.node'), 'utf8')).toBe('original')
      expect(readdirSync(cache)).toEqual([key])
    })

    async function runLaterPass(): Promise<void> {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
      try {
        await gcRelayNativeDepsCache(conn, host, home)
      } finally {
        clock.mockRestore()
      }
    }

    it('claims a referenced legacy tombstone out of old sweeps but never restores it', async () => {
      referenceEntry()
      const path = tombstone(
        Date.now() - 60 * 60_000,
        LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
      )

      await gcRelayNativeDepsCache(conn, host, home)

      expect(existsSync(path)).toBe(false)
      const [claimed] = tombstones()
      expect(existsSync(join(cache, claimed, 'node_modules', 'addon.node'))).toBe(true)
      expect(existsSync(join(cache, claimed, '.deps-complete'))).toBe(false)

      await runLaterPass()

      expect(existsSync(entry)).toBe(false)
      expect(tombstones()).toHaveLength(1)
    })

    it('keeps a legacy tree unrestorable when its claim is interrupted after unmarking', async () => {
      referenceEntry()
      const path = tombstone(
        Date.now() - 60 * 60_000,
        LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
      )
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (command.startsWith(`mv ${shellEscape(path)}`)) {
          throw new Error('claim interrupted')
        }
        return runShell(command)
      })

      await gcRelayNativeDepsCache(conn, host, home)

      expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)
      expect(existsSync(join(path, '.deps-complete'))).toBe(false)

      execMock.mockImplementation(async (_conn: unknown, command: string) => runShell(command))
      await runLaterPass()
      await runLaterPass()

      expect(existsSync(entry)).toBe(false)
    })

    it('collects an unreferenced legacy tombstone', async () => {
      tombstone(Date.now() - 60 * 60_000, LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX)

      await gcRelayNativeDepsCache(conn, host, home)

      expect(readdirSync(cache)).toEqual([])
    })

    it('lets exactly one of two passes claim the same abandoned tombstone', async () => {
      const path = tombstone()
      let releaseClaim!: () => void
      const claimHeld = new Promise<void>((resolve) => {
        releaseClaim = resolve
      })
      let heldPassReachedClaim!: () => void
      const reachedClaim = new Promise<void>((resolve) => {
        heldPassReachedClaim = resolve
      })
      let held = false
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (!held && command.startsWith(`mv ${shellEscape(path)}`)) {
          held = true
          heldPassReachedClaim()
          await claimHeld
        }
        return runShell(command)
      })

      // The held pass sees the tree as unreferenced; the other pins its key and restores it.
      const heldPass = gcRelayNativeDepsCache(conn, host, home)
      await reachedClaim
      await gcRelayNativeDepsCache(conn, host, home, { pinnedKeys: [key] })
      releaseClaim()
      await heldPass

      expect(readdirSync(cache)).toEqual([key])
      expect(readFileSync(join(entry, 'node_modules', 'addon.node'), 'utf8')).toBe('original')
      expect(execMock.mock.calls.some(([, command]) => String(command).includes('rm -rf'))).toBe(
        false
      )
    })

    it('does not let another pass resurrect a tombstone while its owner deletes it', async () => {
      tombstone()
      let otherPass: Promise<void> | undefined
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (!otherPass && command.includes('rm -rf')) {
          // Simulate the owner's deletion being midway: marker and one file already gone.
          const [owned] = tombstones()
          rmSync(join(cache, owned, '.deps-complete'))
          rmSync(join(cache, owned, 'node_modules', 'addon.node'))
          referenceEntry()
          // A later pass on another client sees the owned name as stale and wants the key back.
          const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
          try {
            otherPass = gcRelayNativeDepsCache(conn, host, home, { pinnedKeys: [key] })
            await otherPass
          } finally {
            clock.mockRestore()
          }
        }
        return runShell(command)
      })

      await gcRelayNativeDepsCache(conn, host, home)

      expect(otherPass).toBeDefined()
      expect(existsSync(entry)).toBe(false)
      expect(
        tombstones().filter((name) => existsSync(join(cache, name, '.deps-complete')))
      ).toEqual([])
    })

    it('never restores a tree whose deletion was interrupted, even once its name is stale', async () => {
      tombstone()
      const interrupted = new Error('rm interrupted')
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (command.includes('rm -rf')) {
          runShell(command.slice(0, command.indexOf(' && ')))
          const [owned] = tombstones()
          rmSync(join(cache, owned, 'node_modules', 'addon.node'))
          throw interrupted
        }
        return runShell(command)
      })
      await gcRelayNativeDepsCache(conn, host, home)
      const [owned] = tombstones()
      expect(existsSync(join(cache, owned, 'node_modules'))).toBe(true)

      referenceEntry()
      execMock.mockImplementation(async (_conn: unknown, command: string) => runShell(command))
      await runLaterPass()

      expect(existsSync(entry)).toBe(false)
      expect(tombstones()).toHaveLength(1)
      expect(existsSync(join(cache, tombstones()[0], '.deps-complete'))).toBe(false)
    })

    it('preserves a referenced tombstone when the clock moves backward during the reference scan', async () => {
      referenceEntry()
      const now = Date.now()
      const path = tombstone(now - 30 * 60_000 - 1)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (command.includes('readlink')) {
          clock.mockReturnValue(now - 60_000)
        }
        return runShell(command)
      })
      try {
        await gcRelayNativeDepsCache(conn, host, home)
        expect(readFileSync(join(relay, 'node_modules', 'addon.node'), 'utf8')).toBe('original')
        expect(existsSync(path)).toBe(false)
      } finally {
        clock.mockRestore()
      }
    })

    it('keeps new tombstones outside an old client mtime-only deletion sweep', () => {
      const path = tombstone()
      const legacy = join(cache, `${LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}${key}.123.1`)
      mkdirSync(legacy)
      utimesSync(legacy, new Date(0), new Date(0))

      runShell(
        `find ${shellEscape(cache)} -maxdepth 1 -name '.gc-tombstone.*' -mmin +30 -exec rm -rf {} +`
      )

      expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)
      expect(existsSync(legacy)).toBe(false)
    })

    it.skipIf(process.getuid?.() === 0).each(['root', 'relay'])(
      'preserves tombstones when the %s listing is unreadable',
      async (scope) => {
        const path = tombstone()
        referenceEntry()
        chmodSync(scope === 'root' ? join(home, '.orca-remote') : relay, 0o111)

        await gcRelayNativeDepsCache(conn, host, home)

        expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)
        expect(execMock.mock.calls.some(([, command]) => String(command).includes('rm -rf'))).toBe(
          false
        )
      }
    )

    it('preserves tombstones when a reference cannot be attributed', async () => {
      const path = tombstone()
      symlinkSync('../unknown/node_modules', join(relay, 'node_modules'))

      await gcRelayNativeDepsCache(conn, host, home)

      expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)
      expect(execMock).toHaveBeenCalledTimes(2)
    })

    it('collects a stale tombstone only after two complete reference scans', async () => {
      const path = tombstone()

      await gcRelayNativeDepsCache(conn, host, home)

      expect(existsSync(path)).toBe(false)
      expect(
        execMock.mock.calls.filter(([, command]) => String(command).includes('readlink'))
      ).toHaveLength(2)
    })

    it('collects an interrupted tombstone deletion after its completion marker is gone', async () => {
      const path = tombstone()
      rmSync(join(path, '.deps-complete'))

      await gcRelayNativeDepsCache(conn, host, home)

      expect(existsSync(path)).toBe(false)
    })

    it('leaves incomplete ordinary entries owned by installers alone', async () => {
      rmSync(join(entry, '.deps-complete'))

      await gcRelayNativeDepsCache(conn, host, home)

      expect(readFileSync(join(entry, 'node_modules', 'addon.node'), 'utf8')).toBe('original')
      expect(execMock).toHaveBeenCalledTimes(1)
    })

    it.each([() => Date.now(), () => Date.now() + 60 * 60_000, () => Number.MAX_SAFE_INTEGER + 1])(
      'keeps tombstones with a recent, future, or unsafe name timestamp despite ancient mtime',
      async (timestamp) => {
        const path = tombstone(timestamp())

        await gcRelayNativeDepsCache(conn, host, home)

        expect(existsSync(join(path, 'node_modules', 'addon.node'))).toBe(true)
        expect(execMock).toHaveBeenCalledTimes(1)
      }
    )

    it('restores a link created during rename when the recheck termination is unconfirmed', async () => {
      const error = Object.assign(new Error('read-only recheck timed out'), {
        sshChannelCloseConfirmed: false
      })
      let scans = 0
      execMock.mockImplementation(async (_conn: unknown, command: string) => {
        if (command.includes('readlink') && ++scans === 2) {
          throw error
        }
        const output = runShell(command)
        if (command.startsWith('mv ')) {
          referenceEntry()
        }
        return output
      })

      await expect(gcRelayNativeDepsCache(conn, host, home)).rejects.toBe(error)

      expect(readFileSync(join(relay, 'node_modules', 'addon.node'), 'utf8')).toBe('original')
      expect(readdirSync(cache)).toEqual([key])
      expect(execMock).toHaveBeenCalledTimes(5)
    })

    it.each(['directory', 'dangling symlink'])(
      'does not overwrite or nest inside a recreated %s',
      async (kind) => {
        referenceEntry()
        const path = tombstone()
        if (kind === 'directory') {
          mkdirSync(entry)
          writeFileSync(join(entry, 'replacement'), 'new')
        } else {
          symlinkSync(join(cache, 'missing'), entry)
        }

        await gcRelayNativeDepsCache(conn, host, home)

        expect(existsSync(path)).toBe(false)
        const [claimed] = tombstones()
        expect(readFileSync(join(cache, claimed, 'node_modules', 'addon.node'), 'utf8')).toBe(
          'original'
        )
        if (kind === 'directory') {
          expect(readdirSync(entry)).toEqual(['replacement'])
        } else {
          expect(readlinkSync(entry)).toBe(join(cache, 'missing'))
        }
      }
    )
  }
)
