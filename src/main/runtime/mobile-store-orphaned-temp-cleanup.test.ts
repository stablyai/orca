import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../durable-file-write'
import { DeviceRegistry } from './device-registry'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const stores = [
  [
    'dismissal store',
    'mobile-notification-dismissals.json',
    (dir: string) => new MobileNotificationDismissalStore(dir)
  ],
  ['device registry', DEVICE_REGISTRY_FILENAME, (dir: string) => new DeviceRegistry(dir)]
] as const

it.each(stores)(
  '%s reclaims orphaned temps while preserving active writes and unrelated files',
  async (_, fileName, open) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-orphaned-temp-'))
    dirs.push(dir)
    // Other-process PIDs: the sweep always spares this process's own temps.
    const orphaned = join(dir, `${fileName}.${process.pid + 1}.1784108697605.b306bb91.tmp`)
    const recent = join(dir, `${fileName}.${process.pid + 2}.1784108697605.cafef00d.tmp`)
    const own = join(dir, `${fileName}.${process.pid}.1784108697605.aaaaaaaa.tmp`)
    const otherStore = join(
      dir,
      `${fileName === DEVICE_REGISTRY_FILENAME ? 'mobile-notification-dismissals.json' : DEVICE_REGISTRY_FILENAME}.${process.pid + 1}.0.bbbbbbbb.tmp`
    )
    const similarName = join(dir, `${fileName}-backup.${process.pid + 1}.0.cccccccc.tmp`)
    const wrongSuffix = join(dir, `${fileName}.${process.pid + 1}.0.dddddddd.tmp.backup`)
    const finalPath = join(dir, fileName)
    writeFileSync(orphaned, '[]')
    writeFileSync(recent, '[]')
    writeFileSync(finalPath, '[]')
    const twoDaysAgo = (Date.now() - 2 * 86400_000) / 1000
    for (const path of [orphaned, own, otherStore, similarName, wrongSuffix]) {
      writeFileSync(path, '[]')
      utimesSync(path, twoDaysAgo, twoDaysAgo)
    }

    open(dir)

    await vi.waitFor(() => expect(existsSync(orphaned)).toBe(false))
    for (const path of [recent, own, otherStore, similarName, wrongSuffix, finalPath]) {
      expect(readFileSync(path, 'utf8')).toBe('[]')
    }
  }
)

it.each(stores)('%s loads while startup cleanup is still pending', async (_, fileName, open) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orphaned-temp-pending-'))
  dirs.push(dir)
  writeFileSync(join(dir, fileName), '[]')
  let finishCleanup = () => {}
  const pending = new Promise<void>((resolve) => {
    finishCleanup = resolve
  })
  const cleanup = vi
    .spyOn(durableFileWrite, 'removeStaleDurableWriteTempFiles')
    .mockReturnValue(pending)
  try {
    const store = open(dir)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(store instanceof DeviceRegistry ? store.listDevices() : store.reconcile([])).toEqual([])
  } finally {
    finishCleanup()
    await pending
  }
})
