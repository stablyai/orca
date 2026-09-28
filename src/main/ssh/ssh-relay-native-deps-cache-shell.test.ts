import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  relayNativeDepsCacheEntryDir,
  relayNativeDepsCacheNodeModulesPath
} from './ssh-relay-native-deps-cache'
import {
  listRelayNativeDepsCacheEntriesCommand,
  listRelayNativeDepsCacheReferencesCommand,
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_REFS_OK
} from './ssh-relay-native-deps-cache-commands'

const HOST = getRemoteHostPlatform('linux-x64')
const KEY = 'linux-x64-99355f00e9e557a3'

const SHELLS = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell))

describe.runIf(process.platform !== 'win32').each(SHELLS)(
  'historical relay native cache scans (%s)',
  (shell) => {
    let home: string
    const relayDir = (version: string): string => join(home, '.orca-remote', `relay-${version}`)

    function sh(command: string): string {
      return execFileSync(shell, ['-c', command], { encoding: 'utf-8' })
    }

    function makeLegacyCache(version: string): void {
      const entry = relayNativeDepsCacheEntryDir(HOST, home, KEY)
      const target = relayNativeDepsCacheNodeModulesPath(HOST, home, KEY)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(entry, '.deps-complete'), '')
      mkdirSync(relayDir(version), { recursive: true })
      symlinkSync(target, join(relayDir(version), 'node_modules'))
    }

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-relay-cache-'))
      mkdirSync(join(home, '.orca-remote'), { recursive: true })
    })

    afterEach(() => {
      rmSync(home, { recursive: true, force: true })
    })

    it('reports the published entry and every symlink that references it', () => {
      makeLegacyCache('0.1.0+aaa')

      const entries = sh(listRelayNativeDepsCacheEntriesCommand(HOST, home)).trim().split('\n')
      expect(entries).toEqual([`ENTRY ${KEY}`, RELAY_NATIVE_CACHE_LIST_OK])

      const refs = sh(listRelayNativeDepsCacheReferencesCommand(HOST, home)).trim().split('\n')
      expect(refs).toEqual([
        `REF ${relayNativeDepsCacheNodeModulesPath(HOST, home, KEY)}`,
        RELAY_NATIVE_CACHE_REFS_OK
      ])
    })

    it('reports a symlink no Orca version wrote, so GC can refuse the pass', () => {
      makeLegacyCache('0.1.0+aaa')
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
