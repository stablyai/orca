import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import {
  getServeUpdateHandoffPath,
  parseServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import {
  readServeUpdateHandoff,
  SERVE_REPLACEMENT_READY_TIMEOUT_MS
} from './serve-update-supervisor'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { launchOrcaApp, serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

const RECIPE_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingCode: encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }),
  projectRoot: '/workspace/repo'
})
const SERVE_INSTALL_STATUS = '[serve] orca CLI install: installed'
const SSH_PRIVATE_KEY = 'TOP-SECRET-PRIVATE-KEY'
const SSH_AUTHORIZATION = 'Bearer TOP-SECRET-AUTHORIZATION'
const SSH_PASSPHRASE = 'TOP-SECRET-PASSPHRASE'
const SSH_COOKIE = 'session=TOP-SECRET-COOKIE'
const SSH_RECIPE_JSON = JSON.stringify({
  schemaVersion: 1,
  connection: {
    type: 'ssh',
    target: {
      label: 'Sandbox',
      host: 'sandbox.example.com',
      port: 22,
      username: 'root'
    },
    projectRoot: '/workspace/repo'
  },
  userData: {
    credentials: {
      privateKey: SSH_PRIVATE_KEY,
      authorization: SSH_AUTHORIZATION,
      passphrase: SSH_PASSPHRASE,
      cookie: SSH_COOKIE
    }
  }
})
const INVALID_SSH_RECIPE_JSON = SSH_RECIPE_JSON.replace('/workspace/repo', 'relative/repo')
const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'

function startRecipeJsonServer() {
  const child = new FakeChildProcess()
  spawnMock.mockReturnValue(child)
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const result = serveOrcaApp({
    recipeJson: true,
    projectRoot: '/workspace/repo'
  })
  return { child, result, stdoutSpy, stderrSpy }
}

describe('serveOrcaApp', () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    spawnMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
    delete process.env.ORCA_USER_DATA_PATH
    return Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    )
  })

  it.runIf(process.platform === 'darwin')(
    'keeps the serve supervisor alive until the installed target version can take ownership',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-serve-update-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'Orca.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'Orca')
      const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        infoPlistPath,
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.51</string></dict></plist>'
      )
      process.env.ORCA_APP_EXECUTABLE = executable
      process.env.ORCA_USER_DATA_PATH = userDataPath

      const oldOwner = new FakeChildProcess()
      const replacementOwner = new FakeChildProcess()
      replacementOwner.pid = 4102
      spawnMock.mockReturnValueOnce(oldOwner).mockReturnValueOnce(replacementOwner)
      let supervisorExited = false
      const supervisor = serveOrcaApp({ json: true }).then((code) => {
        supervisorExited = true
        return code
      })
      const childEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv | undefined
      const handoffPath = childEnv?.ORCA_SERVE_UPDATE_HANDOFF_PATH
      expect(handoffPath).toBeTruthy()
      await writeFile(
        handoffPath!,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: oldOwner.pid
        })
      )

      oldOwner.emit('exit', 0, null)
      await Promise.resolve()

      expect(supervisorExited).toBe(false)
      expect(spawnMock).toHaveBeenCalledTimes(1)

      const updateAppPath = join(root, 'Update.app')
      await mkdir(join(updateAppPath, 'Contents'), { recursive: true })
      await writeFile(
        join(updateAppPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      await rename(appPath, join(root, 'Previous.app'))
      await rename(updateAppPath, appPath)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      replacementOwner.emit('message', {
        type: 'orca:serve-ready',
        version: '1.0.61',
        runtimeId: 'runtime-new'
      })

      expect(supervisorExited).toBe(false)
      await vi.waitFor(async () => expect(await readServeUpdateHandoff(handoffPath!)).toBeNull())
      replacementOwner.emit('exit', 0, null)
      await expect(supervisor).resolves.toBe(0)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'records a replacement version mismatch without starting a retry loop',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-serve-update-mismatch-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'Orca.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'Orca')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.ORCA_APP_EXECUTABLE = executable
      process.env.ORCA_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      replacementOwner.pid = 4102
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const supervisor = serveOrcaApp({ json: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      replacementOwner.emit('message', {
        type: 'orca:serve-ready',
        version: '1.0.51',
        runtimeId: 'runtime-old'
      })
      await vi.waitFor(() => expect(replacementOwner.kill).toHaveBeenCalledWith('SIGTERM'))
      replacementOwner.emit('exit', 0, null)

      await expect(supervisor).resolves.toBe(1)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))).toEqual(
        expect.objectContaining({
          phase: 'failed',
          targetVersion: '1.0.61',
          reason: expect.stringContaining('reported version 1.0.51')
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'records replacement spawn failure before rejecting without a retry loop',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-serve-update-spawn-failure-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'Orca.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'Orca')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.ORCA_APP_EXECUTABLE = executable
      process.env.ORCA_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const supervisor = serveOrcaApp({ json: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      replacementOwner.emit('error', new Error('spawn ENOENT'))

      await expect(supervisor).rejects.toThrow('spawn ENOENT')
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))).toEqual(
        expect.objectContaining({
          phase: 'failed',
          targetVersion: '1.0.61',
          reason: expect.stringContaining('spawn ENOENT')
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'fails a replacement that never reports runtime readiness without retrying it',
    async () => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'orca-serve-update-no-readiness-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'Orca.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'Orca')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.ORCA_APP_EXECUTABLE = executable
      process.env.ORCA_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      try {
        const supervisor = serveOrcaApp({ json: true })
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

        await vi.advanceTimersByTimeAsync(SERVE_REPLACEMENT_READY_TIMEOUT_MS)
        expect(replacementOwner.kill).toHaveBeenCalledWith('SIGTERM')
        replacementOwner.emit('exit', 0, null)

        await expect(supervisor).resolves.toBe(1)
        expect(spawnMock).toHaveBeenCalledOnce()
        expect(
          parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))
        ).toEqual(
          expect.objectContaining({
            phase: 'failed',
            reason: expect.stringContaining('did not report serving version')
          })
        )
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('pins the Electron child cwd to the app root instead of the caller cwd', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      ['--serve', '--serve-json'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes mobile pairing through to the foreground server child', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(
      serveOrcaApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        mobilePairing: true
      })
    ).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      [
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        '--serve-pairing-address',
        '100.64.1.20',
        '--serve-mobile-pairing'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes the app root before serve flags for dev Electron executables', async () => {
    process.env.ORCA_APP_EXECUTABLE = '/repo/node_modules/.bin/electron'
    process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveOrcaApp({ json: true, port: '6768' })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/repo/node_modules/.bin/electron',
      [resolve(__dirname, '../../..'), '--serve', '--serve-json', '--serve-port', '6768'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('prints recipe JSON from a detached server child and exits', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const result = serveOrcaApp({
      pairingAddress: 'wss://sandbox.example.com',
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
    queueMicrotask(() => {
      child.stdout.emit('data', `${RECIPE_JSON}\n`)
    })

    await expect(result).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Orca.app/Contents/MacOS/Orca',
      [
        '--serve',
        '--serve-pairing-address',
        'wss://sandbox.example.com',
        '--serve-recipe-json',
        '--serve-project-root',
        '/workspace/repo'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
    expect(writeSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalled()
  })

  it('waits past startup status lines for valid recipe JSON', async () => {
    const { child, result, stdoutSpy, stderrSpy } = startRecipeJsonServer()
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        `${SERVE_INSTALL_STATUS}\n${INVALID_SSH_RECIPE_JSON}\n${SSH_RECIPE_JSON}\n${RECIPE_JSON.slice(0, 40)}`
      )
      child.stdout.emit('data', `${RECIPE_JSON.slice(40)}\n`)
    })

    await expect(result).resolves.toBe(0)

    expect(stderrSpy).toHaveBeenNthCalledWith(1, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    expect(stderrSpy).toHaveBeenNthCalledWith(2, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    expect(stderrSpy).toHaveBeenNthCalledWith(3, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    for (const secret of [SSH_PRIVATE_KEY, SSH_AUTHORIZATION, SSH_PASSPHRASE, SSH_COOKIE]) {
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining(secret))
    }
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('preserves UTF-8 recipe JSON split across Buffer chunks', async () => {
    const { child, result, stdoutSpy } = startRecipeJsonServer()
    const unicodeRecipeJson = RECIPE_JSON.replace('/workspace/repo', '/workspace/café')
    const recipeBuffer = Buffer.from(`${unicodeRecipeJson}\n`)
    const splitIndex = recipeBuffer.indexOf(Buffer.from('é')) + 1
    queueMicrotask(() => {
      child.stdout.emit('data', recipeBuffer.subarray(0, splitIndex))
      child.stdout.emit('data', recipeBuffer.subarray(splitIndex))
    })

    await expect(result).resolves.toBe(0)

    expect(stdoutSpy).toHaveBeenCalledWith(`${unicodeRecipeJson}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the server exits without valid recipe JSON', async () => {
    const { child, result, stdoutSpy, stderrSpy } = startRecipeJsonServer()
    const secrets = ['UPPER-SECRET', 'SLASH-SECRET', 'LEGACY-SECRET', 'PRIVATE-SECRET']
    const untrustedLines = [
      'ORCA://pair?code=UPPER-SECRET',
      'orca://pair/?code=SLASH-SECRET',
      'orca://pair#LEGACY-SECRET',
      '"embedded privateKey PRIVATE-SECRET"',
      '{privateKey:"PRIVATE-SECRET"}'
    ].join('\n')
    queueMicrotask(() => {
      child.stdout.emit('data', `${untrustedLines}\n`)
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })

    await expect(result).rejects.toMatchObject({
      code: 'runtime_serve_failed',
      message: 'Orca serve exited before printing valid recipe JSON with code 0.'
    })
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(5)
    expect(stderrSpy).toHaveBeenCalledWith(`${IGNORED_NON_RECIPE_STDOUT}\n`)
    for (const secret of secrets) {
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining(secret))
    }
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('accepts valid recipe JSON at exit without a trailing newline', async () => {
    const { child, result, stdoutSpy } = startRecipeJsonServer()
    queueMicrotask(() => {
      child.emit('exit', 0, null)
      child.stdout.emit('data', RECIPE_JSON)
      child.emit('close', 0, null)
    })

    await expect(result).resolves.toBe(0)

    expect(stdoutSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('uses a shell when a Windows npm command shim is the Electron executable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ORCA_APP_EXECUTABLE = 'C:\\repo\\node_modules\\.bin\\electron.cmd'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    try {
      await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\repo\\node_modules\\.bin\\electron.cmd',
        ['--serve', '--serve-json'],
        expect.objectContaining({
          shell: true
        })
      )
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})

describe('launchOrcaApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    delete process.env.ORCA_OPEN_COMMAND
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('handles asynchronous detached spawn errors without throwing', async () => {
    process.env.ORCA_APP_EXECUTABLE = '/missing/Orca'
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)

    launchOrcaApp()
    child.emit('error', new Error('ENOENT'))
    await Promise.resolve()

    expect(child.unref).toHaveBeenCalled()
  })
})
