import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  orcadManagedStopRequestFilename,
  ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES
} from '../../shared/orcad-managed-stop-request'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { validateOrcadDecommissionCompletion } from './orcad-decommission-acceptance'
import { createOrcadManagedStopRequestValidator } from './orcad-managed-stop-request'
import { installOrcadStopRequestListener } from './orcad-stop-request-listener'

vi.mock('./orcad-decommission-acceptance', () => ({
  validateOrcadDecommissionCompletion: vi.fn()
}))

describe('authority-bound process stop requests', () => {
  let directory: string
  const identity = { runtimeId: 'runtime', profileId: 'profile', profileRoot: '/profile' }
  const instance = { pid: 123, startedAtMs: null, nonce: 'nonce', lockPath: '/lock' }
  const context = () => ({
    version: '1.0.0',
    identity: { ...identity },
    instance: { ...instance, lockPath: join(directory, 'instance.lock') }
  })
  const request = () => ({
    schemaVersion: 1,
    version: '1.0.0',
    authority: { ...identity, transactionId: '00000000-0000-4000-8000-000000000001' },
    instance: context().instance
  })
  const filename = () => orcadManagedStopRequestFilename(context().instance)
  const path = () => join(directory, filename())
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orcad-bound-stop-request-'))
    vi.mocked(validateOrcadDecommissionCompletion).mockReset().mockReturnValue('accepted')
    writeFileSync(
      context().instance.lockPath,
      JSON.stringify({
        ...context().instance,
        identity: 'test-user',
        version: '1.0.0',
        acquiredAt: '2026-09-06T00:00:00.000Z'
      })
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('checks durable acceptance for the exact transaction and preserves the request', () => {
    const payload = request()
    writeFileSync(path(), JSON.stringify(payload))
    createOrcadManagedStopRequestValidator(context(), directory)(path())
    expect(validateOrcadDecommissionCompletion).toHaveBeenCalledWith(
      payload.authority,
      payload.version,
      directory,
      payload.instance
    )
    expect(existsSync(path())).toBe(true)
  })

  it.each(['runtimeId', 'profileId', 'profileRoot'] as const)('refuses a different %s', (field) => {
    const payload = request()
    payload.authority[field] = 'other'
    writeFileSync(path(), JSON.stringify(payload))
    expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow(
      'identity_mismatch'
    )
    expect(validateOrcadDecommissionCompletion).not.toHaveBeenCalled()
  })

  it.each([{ pid: 456 }, { startedAtMs: 123 }, { nonce: 'replacement' }, { lockPath: '/other' }])(
    'refuses a replacement instance %j',
    (change) => {
      writeFileSync(
        path(),
        JSON.stringify({ ...request(), instance: { ...context().instance, ...change } })
      )
      expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow(
        'identity_mismatch'
      )
      expect(validateOrcadDecommissionCompletion).not.toHaveBeenCalled()
    }
  )

  it.each([
    '{',
    '{}',
    JSON.stringify({ schemaVersion: 2 }),
    ' '.repeat(ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES + 1)
  ])('refuses malformed or oversized requests %#', (contents) => {
    writeFileSync(path(), contents)
    expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow()
    expect(validateOrcadDecommissionCompletion).not.toHaveBeenCalled()
  })

  it('copies startup identity instead of trusting later caller mutation', () => {
    const running = context()
    const validate = createOrcadManagedStopRequestValidator(running)
    running.instance.nonce = 'replacement'
    running.identity.profileId = 'replacement'
    writeFileSync(path(), JSON.stringify(request()))
    expect(() => validate(path())).not.toThrow()
  })

  it('does not replay shutdown for a completed transaction', () => {
    writeFileSync(path(), JSON.stringify(request()))
    vi.mocked(validateOrcadDecommissionCompletion).mockReturnValue('process-exited')
    expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow(
      'already_completed'
    )
  })

  it.each(['missing', 'replacement', 'malformed'])('refuses a %s instance lock', (state) => {
    writeFileSync(path(), JSON.stringify(request()))
    if (state === 'missing') {
      rmSync(context().instance.lockPath)
    } else {
      writeFileSync(
        context().instance.lockPath,
        state === 'malformed'
          ? '{'
          : JSON.stringify({
              ...context().instance,
              nonce: 'replacement',
              identity: 'test-user',
              version: '1.0.0',
              acquiredAt: '2026-09-06T00:00:00.000Z'
            })
      )
    }
    expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow(
      state === 'missing' ? 'ENOENT' : 'instance_lock_changed'
    )
  })

  it('refuses a different version before acceptance validation', () => {
    writeFileSync(path(), JSON.stringify({ ...request(), version: '2.0.0' }))
    expect(() => createOrcadManagedStopRequestValidator(context())(path())).toThrow(
      'identity_mismatch'
    )
    expect(validateOrcadDecommissionCompletion).not.toHaveBeenCalled()
  })

  it('ignores legacy requests, retries absent acceptance, and invokes shutdown only once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRequest = vi.fn()
    let notify: (event: string, filename: string | null) => void = () => {}
    const watcher = { on: vi.fn(), unref: vi.fn(), close: vi.fn() }
    writeFileSync(join(directory, ORCAD_STOP_REQUEST_FILENAME), '')
    const listener = installOrcadStopRequestListener(onRequest, {
      installRoot: '/unused-slot',
      managedStop: context(),
      managedHome: directory,
      watchDirectory: vi.fn((_directory, callback) => {
        expect(_directory).toBe(directory)
        notify = callback
        return watcher
      }) as never
    })
    try {
      expect(onRequest).not.toHaveBeenCalled()
      writeFileSync(path(), JSON.stringify(request()))
      vi.mocked(validateOrcadDecommissionCompletion).mockImplementationOnce(() => {
        throw new Error('acceptance absent')
      })
      notify('change', filename())
      expect(onRequest).not.toHaveBeenCalled()
      expect(existsSync(path())).toBe(true)
      notify('change', ORCAD_STOP_REQUEST_FILENAME)
      expect(onRequest).not.toHaveBeenCalled()
      notify('change', filename())
      notify('change', null)
      expect(onRequest).toHaveBeenCalledOnce()
      expect(validateOrcadDecommissionCompletion).toHaveBeenCalledTimes(2)
      expect(existsSync(path())).toBe(true)
    } finally {
      listener.close()
    }
  })
})
