import { lookup } from 'node:dns/promises'
import { lstat, readlink } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isDeviceNamespacePath,
  isNetworkSharePath,
  isWindowsReservedDeviceName
} from '../ipc/automatic-load-path-text'

export const CHAT_PREVIEW_MAX_SOURCE_LENGTH = 8192
export const CHAT_PREVIEW_MAX_ID_LENGTH = 128
export const CHAT_PREVIEW_DNS_TIMEOUT_MS = 10_000

export class PrivatePreviewAddressError extends Error {
  constructor() {
    super('This address needs permission to access a private network.')
  }
}

const nonPublicV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  nonPublicV4.addSubnet(address, prefix, 'ipv4')
}
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const nonPublicV6 = new BlockList()
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
] as const) {
  nonPublicV6.addSubnet(address, prefix, 'ipv6')
}

export function isPublicPreviewAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return !nonPublicV4.check(address, 'ipv4')
  }
  return (
    isIP(address) === 6 && globalV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6')
  )
}

export function isValidPreviewId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CHAT_PREVIEW_MAX_ID_LENGTH &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  )
}

export function parsePreviewNetworkUrl(source: string): URL {
  if (source.length > CHAT_PREVIEW_MAX_SOURCE_LENGTH || /[\p{Cc}\s]/u.test(source)) {
    throw new Error('Invalid preview URL')
  }
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP(S) preview URLs are allowed')
  }
  url.hash = ''
  return url
}

/** Refuse shares and device paths before realpath/open can contact a host or device. */
export function assertPreviewLocalPath(filePath: string): void {
  if (
    !isAbsolute(filePath) ||
    /\p{Cc}/u.test(filePath) ||
    /^[\\/]{2}/.test(filePath) ||
    isDeviceNamespacePath(filePath) ||
    isNetworkSharePath(filePath) ||
    isWindowsReservedDeviceName(filePath)
  ) {
    throw new Error('Only absolute local regular-file paths can be previewed')
  }
}

export function parsePreviewLocalPath(source: string): string {
  let filePath = source
  if (/^file:/i.test(source)) {
    const url = new URL(source)
    if (url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('File preview URLs must name a local file without query or fragment')
    }
    filePath = fileURLToPath(url)
  }
  assertPreviewLocalPath(filePath)
  const normalized = resolve(filePath)
  assertPreviewLocalPath(normalized)
  return normalized
}

/** Inspect link targets before following them, including links in parent directories. */
export async function resolvePreviewLocalSymlinks(
  filePath: string,
  signal: AbortSignal
): Promise<string> {
  let path = filePath
  for (let links = 0; links <= 40; links++) {
    assertPreviewLocalPath(path)
    const root = parse(path).root
    const parts = path.slice(root.length).split(sep).filter(Boolean)
    let current = root
    let linked = false
    for (let index = 0; index < parts.length; index++) {
      signal.throwIfAborted()
      current = join(current, parts[index])
      if (!(await lstat(current)).isSymbolicLink()) {
        continue
      }
      const target = await readlink(current)
      if (/^[\\/]{2}/.test(target)) {
        throw new Error('Network-share links cannot be previewed')
      }
      const resolved = isAbsolute(target) ? target : resolve(dirname(current), target)
      assertPreviewLocalPath(resolved)
      path = join(resolved, ...parts.slice(index + 1))
      linked = true
      break
    }
    if (!linked) {
      return current
    }
  }
  throw new Error('Preview path contains too many symbolic links')
}

export async function resolvePreviewAddress(
  url: URL,
  allowPrivateNetwork: boolean,
  signal: AbortSignal
): Promise<{ address: string; family: number }> {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  let addresses = [{ address: hostname, family }]
  if (!family) {
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => cancelled.reject(signal.reason ?? new Error('Preview cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => cancelled.reject(new Error('Preview DNS lookup timed out')),
      CHAT_PREVIEW_DNS_TIMEOUT_MS
    )
    timer.unref()
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        cancelled.promise
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  signal.throwIfAborted()
  if (!addresses.length || addresses.some((entry) => !isIP(entry.address))) {
    throw new Error('Preview host has no usable address')
  }
  // Check every answer, not just the one selected for the socket.
  if (!allowPrivateNetwork && addresses.some((entry) => !isPublicPreviewAddress(entry.address))) {
    throw new PrivatePreviewAddressError()
  }
  return addresses[0]
}
