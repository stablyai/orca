import type * as NodeFs from 'node:fs'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import { grantClaudeFolderTrust } from './claude-folder-trust-file'

const { DISTRO, GUEST_PREFIX, guest } = vi.hoisted(() => ({
  DISTRO: 'Ubuntu-24.04',
  GUEST_PREFIX: '//wsl.localhost/Ubuntu-24.04',
  guest: { root: '' }
}))

function toGuestDisk(path: string): string {
  return path.startsWith(GUEST_PREFIX) ? `${guest.root}${path.slice(GUEST_PREFIX.length)}` : path
}

// Why: models Windows Node over \\wsl.localhost: a synthetic 0o666 mode, chmod that cannot reach
// the guest bits, and new files at the guest's default 0644 whatever mode was requested.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const onGuest = (path: unknown): path is string =>
    typeof path === 'string' && path.startsWith(GUEST_PREFIX)
  const disk = (path: string): string => `${guest.root}${path.slice(GUEST_PREFIX.length)}`
  const windowsView = (stats: NodeFs.Stats): NodeFs.Stats =>
    Object.assign(stats, { mode: (stats.mode & ~0o777) | 0o666 })
  return {
    ...actual,
    existsSync: (path: string) => actual.existsSync(onGuest(path) ? disk(path) : path),
    lstatSync: (path: string) =>
      onGuest(path) ? windowsView(actual.lstatSync(disk(path))) : actual.lstatSync(path),
    statSync: (path: string) =>
      onGuest(path) ? windowsView(actual.statSync(disk(path))) : actual.statSync(path),
    realpathSync: (path: string) =>
      onGuest(path)
        ? `${GUEST_PREFIX}${actual.realpathSync(disk(path)).slice(guest.root.length)}`
        : actual.realpathSync(path),
    readFileSync: (path: string, options: BufferEncoding) =>
      actual.readFileSync(onGuest(path) ? disk(path) : path, options),
    writeFileSync: (path: string, data: string, options?: NodeFs.WriteFileOptions) => {
      if (!onGuest(path)) {
        return actual.writeFileSync(path, data, options)
      }
      const created = !actual.existsSync(disk(path))
      const flag = typeof options === 'object' && options ? options.flag : undefined
      actual.writeFileSync(disk(path), data, { flag })
      if (created) {
        actual.chmodSync(disk(path), 0o644)
      }
    },
    chmodSync: (path: string, mode: number) =>
      onGuest(path) ? undefined : actual.chmodSync(path, mode),
    renameSync: (from: string, to: string) =>
      actual.renameSync(onGuest(from) ? disk(from) : from, onGuest(to) ? disk(to) : to),
    rmSync: (path: string, options?: NodeFs.RmOptions) =>
      actual.rmSync(onGuest(path) ? disk(path) : path, options)
  }
})

vi.mock('proper-lockfile', () => ({
  lock: vi.fn(async () => async () => {})
}))

const runWslProcess = vi.hoisted(() => vi.fn<(spec: WslSpec) => Promise<WslResult>>())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))

/** Runs `chmod --reference=<from> -- <to>` as the guest would. */
async function guestChmod(spec: WslSpec): Promise<WslResult> {
  const [reference, separator, target] = spec.args ?? []
  expect(spec).toMatchObject({ distro: DISTRO, loginPath: 'none', program: 'chmod' })
  expect(separator).toBe('--')
  const from = `${guest.root}${reference.replace(/^--reference=/, '')}`
  chmodSync(`${guest.root}${target}`, statSync(from).mode & 0o7777)
  return {
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false
  }
}

const originalPlatform = process.platform

describe.skipIf(originalPlatform === 'win32')('grantClaudeFolderTrust on a WSL guest file', () => {
  const guestFile = `${GUEST_PREFIX}/home/u/.claude.json`

  beforeEach(() => {
    guest.root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-guest-')))
    mkdirSync(join(guest.root, 'home/u'), { recursive: true })
    writeFileSync(toGuestDisk(guestFile), JSON.stringify({ theme: 'dark' }))
    chmodSync(toGuestDisk(guestFile), 0o600)
    runWslProcess.mockReset().mockImplementation(guestChmod)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    rmSync(guest.root, { recursive: true, force: true })
  })

  it("keeps the guest file's owner-only mode through the rewrite", async () => {
    await expect(
      grantClaudeFolderTrust({ configFile: guestFile, folderKeys: ['/home/u/wt'] })
    ).resolves.toBe('granted')
    expect(statSync(toGuestDisk(guestFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(toGuestDisk(guestFile), 'utf-8'))).toEqual({
      theme: 'dark',
      projects: { '/home/u/wt': { hasTrustDialogAccepted: true } }
    })
  })

  it('leaves the file untouched when the guest cannot copy its mode', async () => {
    runWslProcess.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      stdout: '',
      stderr: "chmod: unrecognized option '--reference'",
      timedOut: false,
      outputTruncated: false
    })
    await expect(
      grantClaudeFolderTrust({ configFile: guestFile, folderKeys: ['/home/u/wt'] })
    ).rejects.toThrow(/guest mode/)
    expect(readFileSync(toGuestDisk(guestFile), 'utf-8')).toBe(JSON.stringify({ theme: 'dark' }))
    expect(statSync(toGuestDisk(guestFile)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(guest.root, 'home/u'))).toEqual(['.claude.json'])
  })
})
