import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOrCreateMockServerKeyPair } from '../scripts/mock-server-key-pair'

const temporaryDirectories: string[] = []

type ConcurrentCreator = {
  ready: Promise<void>
  calling: Promise<void>
  start: () => void
  stop: () => void
  closed: Promise<void>
  result: Promise<string>
}

function keyFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mock-key-'))
  temporaryDirectories.push(directory)
  return join(directory, 'server-key')
}

function runConcurrentCreator(keyFile: string): ConcurrentCreator {
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, '../scripts/mock-server-key-pair.ts')
  ).href
  const script = `
    const { loadOrCreateMockServerKeyPair } = await import(process.argv[1])
    process.stdout.write('READY\\n')
    await new Promise((resolve) => process.stdin.once('data', resolve))
    process.stdout.write('CALLING\\n')
    const keyPair = loadOrCreateMockServerKeyPair(process.argv[2], { warn() {} })
    process.stdout.write('KEY:' + Buffer.from(keyPair.secretKey).toString('base64') + '\\n')
  `
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script, moduleUrl, keyFile],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveCalling!: () => void
  let rejectCalling!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const calling = new Promise<void>((resolve, reject) => {
    resolveCalling = resolve
    rejectCalling = reject
  })
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const timeout = setTimeout(() => child.kill(), 5_000)
  timeout.unref()
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    if (stdout.includes('READY\n')) {
      resolveReady()
    }
    if (stdout.includes('CALLING\n')) {
      resolveCalling()
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const result = new Promise<string>((resolve, reject) => {
    child.on('error', (error) => {
      rejectReady(error)
      rejectCalling(error)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolveClosed()
      const error = new Error(stderr || `Concurrent key creator exited ${code}`)
      if (!stdout.includes('READY\n')) {
        rejectReady(error)
      }
      if (!stdout.includes('CALLING\n')) {
        rejectCalling(error)
      }
      const key = stdout.match(/KEY:([A-Za-z0-9+/=]+)\n/)?.[1]
      if (code === 0 && key) {
        resolve(key)
      } else {
        reject(error)
      }
    })
  })
  void result.catch(() => {})
  return {
    ready,
    calling,
    start: () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end('go\n')
      }
    },
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    },
    closed,
    result
  }
}

async function cleanupConcurrentCreators(
  creators: ConcurrentCreator[],
  lockFile: string,
  removeLock: boolean
): Promise<void> {
  let lockRemovalError: unknown
  if (removeLock) {
    try {
      rmSync(lockFile, { force: true })
    } catch (error) {
      lockRemovalError = error
    }
  }
  creators.forEach((creator) => {
    creator.start()
    creator.stop()
  })
  await Promise.allSettled(creators.flatMap((creator) => [creator.result, creator.closed]))
  if (lockRemovalError) {
    throw lockRemovalError
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('mock server key persistence', () => {
  it('persists one private key and reuses it after restart', () => {
    const keyFile = keyFilePath()
    const first = loadOrCreateMockServerKeyPair(keyFile, { warn: vi.fn() })
    const second = loadOrCreateMockServerKeyPair(keyFile)

    expect(second.secretKey).toEqual(first.secretKey)
    expect(readFileSync(keyFile, 'utf-8')).toBe(Buffer.from(first.secretKey).toString('base64'))
    expect(readdirSync(dirname(keyFile))).toEqual(['server-key'])
    if (process.platform !== 'win32') {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    }
  })

  it('re-keys canonical-length content with malformed base64', () => {
    const keyFile = keyFilePath()
    const encoded = Buffer.from(nacl.box.keyPair().secretKey).toString('base64')
    const malformed = `${encoded.slice(0, 4)}!${encoded.slice(4)}`
    expect(Buffer.from(malformed, 'base64')).toHaveLength(nacl.box.secretKeyLength)
    writeFileSync(keyFile, malformed)
    const logger = { warn: vi.fn() }

    const loaded = loadOrCreateMockServerKeyPair(keyFile, logger)

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid base64'))
    expect(readFileSync(keyFile, 'utf-8')).toBe(Buffer.from(loaded.secretKey).toString('base64'))
  })

  it('makes concurrent creators converge on the persisted winner', async () => {
    const keyFile = keyFilePath()
    const lockFile = `${keyFile}.lock`
    writeFileSync(lockFile, '', { flag: 'wx', mode: 0o600 })
    const firstCreator = runConcurrentCreator(keyFile)
    const secondCreator = runConcurrentCreator(keyFile)
    const creators = [firstCreator, secondCreator]
    let parentOwnsLock = true
    try {
      await Promise.all(creators.map((creator) => creator.ready))
      creators.forEach((creator) => creator.start())
      await Promise.all(creators.map((creator) => creator.calling))
      await new Promise((resolve) => setTimeout(resolve, 50))
      rmSync(lockFile)
      parentOwnsLock = false
      const [first, second] = await Promise.all(creators.map((creator) => creator.result))

      expect(second).toBe(first)
      expect(readFileSync(keyFile, 'utf-8')).toBe(first)
      expect(readdirSync(dirname(keyFile))).toEqual(['server-key'])
    } finally {
      await cleanupConcurrentCreators(creators, lockFile, parentOwnsLock)
    }
  })

  it('does not overwrite an invalid key owned by another creator', () => {
    const keyFile = keyFilePath()
    writeFileSync(keyFile, 'invalid')
    writeFileSync(`${keyFile}.lock`, '', { flag: 'wx', mode: 0o600 })

    expect(() => loadOrCreateMockServerKeyPair(keyFile)).toThrow('remained busy')
    expect(readFileSync(keyFile, 'utf-8')).toBe('invalid')
  })
})
