import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import '../../shared/serve-update-handoff'
import './serve-update-supervisor'

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock
}))
import { serveOrcaApp } from './launch'

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
const PROFILE = resolve('/profiles/serve')

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
    spawnSyncMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    process.env.ORCA_USER_DATA_PATH = PROFILE
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_SERVE_RUNTIME
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
    delete process.env.ORCA_USER_DATA_PATH
    return Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    )
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
})
