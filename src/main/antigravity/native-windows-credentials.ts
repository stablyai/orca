import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'
import {
  decodeAntigravityWindowsToken,
  parseAntigravityWindowsSnapshot,
  projectAntigravityWindowsToken
} from './native-windows-token-decode'
import {
  createAntigravityFileCredentialBackend,
  isAntigravityFileStorageHost
} from './native-file-credentials'
import type { AntigravityCredentialBackend } from './native-account-service'

const nativeTarget = 'gemini:antigravity'

export function getAntigravityWindowsHome(env: NodeJS.ProcessEnv): string {
  const home = Object.entries(env).find(([key]) => key.toUpperCase() === 'USERPROFILE')?.[1]
  if (!home) {
    throw new Error('Antigravity requires USERPROFILE to locate its Windows credentials.')
  }
  return home
}

function security() {
  const loaded = loadWindowsSecurity()
  if ('error' in loaded) {
    throw new Error('The Antigravity Windows credential store is unavailable.')
  }
  return loaded.addon
}

class NativeCredentialReadFailure extends Error {
  constructor(readonly win32Code: number) {
    super('The Antigravity Windows credential store could not be read.')
  }
}

function readNativeBytes(target: string): Uint8Array | null {
  let bytes: Uint8Array | null
  try {
    bytes = security().readGenericCredential(target)
  } catch (error) {
    if (
      error instanceof Error &&
      'syscall' in error &&
      error.syscall === 'CredReadW' &&
      'win32Code' in error &&
      typeof error.win32Code === 'number' &&
      Number.isInteger(error.win32Code) &&
      error.win32Code > 0
    ) {
      if (error.win32Code === 1168) {
        return null
      }
      throw new NativeCredentialReadFailure(error.win32Code)
    }
    throw new Error('The Antigravity Windows credential store could not be read.')
  }
  if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.byteLength > 2560)) {
    throw new Error('The Antigravity Windows credential store could not be read.')
  }
  return bytes
}

export async function readAntigravityWindowsCredentialContents(
  target = nativeTarget
): Promise<string | null> {
  const bytes = readNativeBytes(target)
  try {
    return bytes === null
      ? null
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('The Antigravity Windows credential store could not be read.')
  }
}

export async function readAntigravityWindowsCredential(target = nativeTarget) {
  const bytes = readNativeBytes(target)
  return bytes === null ? null : projectAntigravityWindowsToken(bytes)
}

function writeNative(contents: string, target: string) {
  const bytes = Buffer.from(contents, 'utf8')
  if (bytes.length > 2560) {
    throw new Error('Antigravity credentials exceed the Windows credential size limit.')
  }
  try {
    security().writeGenericCredential(target, 'antigravity', bytes)
  } catch {
    throw new Error('The Antigravity Windows credential store could not be updated.')
  }
}

export async function writeAntigravityWindowsCredential(contents: string, target = nativeTarget) {
  parseAntigravityWindowsSnapshot(contents)
  writeNative(contents, target)
  if ((await readAntigravityWindowsCredential(target))?.contents !== contents) {
    throw new Error('The Antigravity Windows credential update could not be verified.')
  }
}

export function isAntigravityWindowsFileHost(env: NodeJS.ProcessEnv): boolean {
  const folded = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key.toUpperCase(), value])
  )
  if (isAntigravityFileStorageHost(folded) || existsSync('/.dockerenv')) {
    return true
  }
  for (const [path, pattern] of [
    ['/proc/1/cgroup', /docker|containerd|kubepods/],
    ['/proc/sys/kernel/osrelease', /microsoft|wsl/i]
  ] as const) {
    try {
      if (pattern.test(readFileSync(path, 'utf8'))) {
        return true
      }
    } catch {}
  }
  return false
}

export function createAntigravityWindowsCredentialBackend(
  home: string,
  isFileHost = isAntigravityWindowsFileHost
): AntigravityCredentialBackend {
  const file = createAntigravityFileCredentialBackend(
    join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    parseAntigravityWindowsSnapshot
  )
  async function effective() {
    if (isFileHost(process.env)) {
      return { current: await file.read(), file: true }
    }
    let nativeError: unknown
    try {
      const bytes = readNativeBytes(nativeTarget)
      if (bytes !== null) {
        const decoded = decodeAntigravityWindowsToken(bytes)
        if (decoded) {
          return { current: projectAntigravityWindowsToken(bytes, decoded), file: false }
        }
        nativeError = new Error('The Antigravity Windows credential store could not be decoded.')
      }
    } catch (error) {
      if (!(error instanceof NativeCredentialReadFailure)) {
        throw error
      }
      nativeError = error
    }
    const current = await file.read()
    if (!current && nativeError) {
      throw nativeError
    }
    return { current, file: current !== null }
  }
  return {
    parse: parseAntigravityWindowsSnapshot,
    async read() {
      return (await effective()).current
    },
    async write(contents, expected) {
      parseAntigravityWindowsSnapshot(contents)
      const route = await effective()
      if ((route.current?.contents ?? null) !== expected) {
        throw new Error(
          'The native Antigravity credential changed during selection; refresh before retrying.'
        )
      }
      await (route.file ? file.write(contents, expected) : writeNative(contents, nativeTarget))
      if ((await effective()).current?.contents !== contents) {
        throw new Error('The Antigravity Windows credential update could not be verified.')
      }
    }
  }
}
