import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { getCursorCliConfigPath } from '../rate-limits/cursor-auth-paths'
import {
  isSafeCursorSecret,
  projectCursorCredential,
  type CursorCredentialSnapshot,
  type CursorNativeCredential
} from './cursor-native-credential'

export type CursorCredentialBackend = {
  read(): Promise<CursorNativeCredential | null>
  /** Replaces the whole sign-in; refuses when the CLI no longer holds `expectedAccessToken`. */
  write(snapshot: CursorCredentialSnapshot, expectedAccessToken: string | null): Promise<void>
}

const ACCOUNT = 'cursor-user'
const ACCESS_SERVICE = 'cursor-access-token'
const REFRESH_SERVICE = 'cursor-refresh-token'
const API_KEY_SERVICE = 'cursor-api-key'
const MAX_COMMAND_BYTES = 4096

function unavailable(): Error {
  return new Error('The Cursor macOS credential store could not be accessed.')
}

async function runSecurity(args: string[], input?: string) {
  try {
    return await runProcess({
      program: '/usr/bin/security',
      args,
      input,
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024
    })
  } catch {
    // Child-process errors may embed credential-bearing output.
    throw unavailable()
  }
}

async function readItem(service: string): Promise<string | null> {
  const result = await runSecurity(['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'])
  if (result.timedOut || result.signal || result.outputTruncated) {
    throw unavailable()
  }
  if (result.code === 44) {
    return null
  }
  const value = result.stdout.trim()
  if (result.code !== 0 || !value) {
    throw unavailable()
  }
  return value
}

async function writeItem(service: string, value: string): Promise<void> {
  if (!isSafeCursorSecret(value)) {
    throw new Error('Cursor credentials contain characters Orca cannot store safely.')
  }
  const input = `add-generic-password -U -s "${service}" -a "${ACCOUNT}" -w ${value}\n`
  if (Buffer.byteLength(input) > MAX_COMMAND_BYTES) {
    throw new Error('Cursor credentials exceed the macOS credential command limit.')
  }
  const result = await runSecurity(['-i'], input)
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw unavailable()
  }
}

async function deleteItem(service: string): Promise<void> {
  const result = await runSecurity(['delete-generic-password', '-s', service, '-a', ACCOUNT])
  if (result.timedOut || result.signal || (result.code !== 0 && result.code !== 44)) {
    throw unavailable()
  }
}

async function setItem(service: string, value: string | null): Promise<void> {
  await (value === null ? deleteItem(service) : writeItem(service, value))
}

const recordSchema = z.record(z.string(), z.unknown())

function readCliConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {}
  }
  const parsed = recordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    throw new Error('The Cursor CLI config is not an object.')
  }
  return parsed.data
}

function readAuthInfo(path: string): Record<string, unknown> | null {
  try {
    const parsed = recordSchema.safeParse(readCliConfig(path).authInfo)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeAuthInfo(path: string, authInfo: Record<string, unknown> | null): void {
  const config = readCliConfig(path)
  if (authInfo) {
    config.authInfo = authInfo
  } else {
    delete config.authInfo
  }
  const temporary = `${path}.orca-${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function createCursorMacOSCredentialBackend(
  configPath: string = getCursorCliConfigPath()
): CursorCredentialBackend {
  async function readSnapshot(): Promise<CursorCredentialSnapshot | null> {
    const accessToken = await readItem(ACCESS_SERVICE)
    if (!accessToken) {
      return null
    }
    return {
      accessToken,
      refreshToken: await readItem(REFRESH_SERVICE),
      apiKey: await readItem(API_KEY_SERVICE),
      authInfo: readAuthInfo(configPath)
    }
  }

  async function apply(snapshot: CursorCredentialSnapshot): Promise<void> {
    await writeItem(ACCESS_SERVICE, snapshot.accessToken)
    await setItem(REFRESH_SERVICE, snapshot.refreshToken)
    await setItem(API_KEY_SERVICE, snapshot.apiKey)
    writeAuthInfo(configPath, snapshot.authInfo)
  }

  return {
    async read() {
      if (process.platform !== 'darwin') {
        throw new Error('The Cursor macOS credential store is unavailable on this host.')
      }
      const snapshot = await readSnapshot()
      return snapshot ? projectCursorCredential(snapshot) : null
    },
    async write(snapshot, expectedAccessToken) {
      if (process.platform !== 'darwin') {
        throw new Error('The Cursor macOS credential store is unavailable on this host.')
      }
      projectCursorCredential(snapshot)
      const previous = await readSnapshot()
      if ((previous?.accessToken ?? null) !== expectedAccessToken) {
        throw new Error('The Cursor sign-in changed while switching; refresh before retrying.')
      }
      try {
        await apply(snapshot)
        const actual = await readSnapshot()
        if (
          actual?.accessToken !== snapshot.accessToken ||
          actual.refreshToken !== snapshot.refreshToken ||
          actual.apiKey !== snapshot.apiKey
        ) {
          throw new Error('The Cursor sign-in update could not be verified.')
        }
      } catch (error) {
        // A half-applied switch would pair one account's access token with another's refresh token.
        if (previous) {
          await apply(previous).catch(() => undefined)
        }
        throw error
      }
    }
  }
}
