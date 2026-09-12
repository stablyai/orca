import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserDownloadDestinationReservations } from './browser-download-destination'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'orca-download-identity-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function directoryAlias(): { real: string; alias: string } {
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  mkdirSync(real)
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return { real, alias }
}

it('reserves directory aliases as one destination without changing the requested path', () => {
  const { real, alias } = directoryAlias()
  const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: real })
  const requested = path.join(alias, 'proof.txt')
  const first = reservations.reserveRequestedPath(requested)
  expect(first.savePath).toBe(requested)
  expect(() => reservations.reserveRequestedPath(path.join(real, 'proof.txt'))).toThrow(
    /already exists or is in use/
  )
  expect(reservations.reserve('proof.txt').filename).toBe('proof (1).txt')
  reservations.release(first.reservationKey)
  expect(reservations.reserveRequestedPath(path.join(real, 'proof.txt')).reservationKey).toBe(
    first.reservationKey
  )
})

it('also refuses an explicit alias after a native reservation', () => {
  const { real, alias } = directoryAlias()
  const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: alias })
  reservations.reserve('proof.txt')
  expect(() => reservations.reserveRequestedPath(path.join(real, 'proof.txt'))).toThrow(
    /already exists or is in use/
  )
})

it('creates requested parents and supports a nonexistent leaf through an alias', () => {
  const { real, alias } = directoryAlias()
  const reservations = new BrowserDownloadDestinationReservations()
  const destination = reservations.reserveRequestedPath(path.join(alias, 'nested', 'proof.txt'))
  expect(destination.savePath).toBe(path.join(alias, 'nested', 'proof.txt'))
  expect(() => reservations.reserveRequestedPath(path.join(real, 'nested', 'proof.txt'))).toThrow()
})

it.each(['win32', 'darwin', 'linux'] as const)(
  'preserves %s filename case policy after resolving aliases',
  (platform) => {
    const { real, alias } = directoryAlias()
    const reservations = new BrowserDownloadDestinationReservations({ platform })
    reservations.reserveRequestedPath(path.join(alias, 'Report.txt'))
    const reserveLowercase = () => reservations.reserveRequestedPath(path.join(real, 'report.txt'))
    if (platform === 'linux') {
      expect(reserveLowercase).not.toThrow()
    } else {
      expect(reserveLowercase).toThrow(/already exists or is in use/)
    }
  }
)

it.each(['EACCES', 'ELOOP', 'ENOENT'])(
  'fails closed when parent resolution fails with %s',
  (code) => {
    const resolveDirectory = vi.fn<(directory: string) => string>(() => {
      throw Object.assign(new Error('Cannot resolve directory'), { code })
    })
    const reservations = new BrowserDownloadDestinationReservations({ realpath: resolveDirectory })
    const requested = path.join(root, 'proof.txt')
    expect(() => reservations.reserveRequestedPath(requested)).toThrow('Cannot resolve directory')
    resolveDirectory.mockImplementation(realpathSync.native)
    expect(() => reservations.reserveRequestedPath(requested)).not.toThrow()
  }
)

it('refuses a file parent and a dangling destination symlink without following the leaf', () => {
  const reservations = new BrowserDownloadDestinationReservations()
  const parent = path.join(root, 'file')
  writeFileSync(parent, 'keep')
  expect(() => reservations.reserveRequestedPath(path.join(parent, 'proof.txt'))).toThrow()
  // Directory junctions do not need Windows symlink privileges.
  const leaf = path.join(root, 'leaf')
  symlinkSync(path.join(root, 'missing'), leaf, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => reservations.reserveRequestedPath(leaf)).toThrow(/already exists or is in use/)
})
