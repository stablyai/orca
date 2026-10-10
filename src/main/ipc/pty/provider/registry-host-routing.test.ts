import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { getCwdFromRuntimeController, resizePtyFromRuntimeController } from '../runtime/operations'
import { deletePtyOwnership, setPtyOwnership } from './ownership-state'
import {
  getLocalPtyProvider,
  getProvider,
  getProviderForPty,
  getPtySshConnectionId,
  hasPtyProviderForInspection,
  PtyHostNotDispatchableError,
  registeredPtyProviders,
  registerSshPtyProvider,
  setLocalPtyProvider,
  tryGetProviderForPty,
  unregisterSshPtyProvider
} from './registry'

function answeringProvider(): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the routed calls below only touch these members.
  return {
    resize: vi.fn(),
    getCwd: vi.fn(async () => '/local/cwd')
  } as unknown as IPtyProvider
}

const PAIRED_RUNTIME_PTY_ID = 'remote:env-1@@handle-1'
const UNNAMED_PAIRED_RUNTIME_PTY_ID = 'remote:handle-1'
const MALFORMED_SSH_PTY_ID = 'ssh:target-only'

describe('PTY ids that name another host', () => {
  const originalLocal = getLocalPtyProvider()
  afterEach(() => setLocalPtyProvider(originalLocal))

  it.each([PAIRED_RUNTIME_PTY_ID, UNNAMED_PAIRED_RUNTIME_PTY_ID, MALFORMED_SSH_PTY_ID])(
    'never routes %s to this machine',
    async (ptyId) => {
      const local = answeringProvider()
      setLocalPtyProvider(local)

      expect(() => getProviderForPty(ptyId)).toThrow()
      expect(tryGetProviderForPty(ptyId)).toBeUndefined()
      expect(hasPtyProviderForInspection(ptyId)).toBe(false)
      expect(resizePtyFromRuntimeController(ptyId, 80, 24)).toBe(false)
      expect(await getCwdFromRuntimeController(ptyId)).toBeNull()
      expect(local.resize).not.toHaveBeenCalled()
      expect(local.getCwd).not.toHaveBeenCalled()
    }
  )

  it('still routes an unowned bare id to this machine', () => {
    const local = answeringProvider()
    setLocalPtyProvider(local)

    expect(getProviderForPty('wt-1@@abcd1234')).toBe(local)
    expect(hasPtyProviderForInspection('wt-1@@abcd1234')).toBe(true)
  })
})

describe('PTY registry keyed by execution host', () => {
  const originalLocal = getLocalPtyProvider()
  afterEach(() => {
    setLocalPtyProvider(originalLocal)
    unregisterSshPtyProvider('box 1')
    deletePtyOwnership('wt-1@@abcd1234')
  })

  it('lists this machine and each relay under its host id', () => {
    const local = answeringProvider()
    const relay = answeringProvider()
    setLocalPtyProvider(local)
    registerSshPtyProvider('box 1', relay)

    expect(registeredPtyProviders()).toEqual([
      { provider: local, hostId: 'local' },
      { provider: relay, hostId: 'ssh:box%201' }
    ])
    expect(getProvider('local')).toBe(local)
    expect(getProvider('ssh:box%201')).toBe(relay)
    expect(() => getProvider('ssh:box-2')).toThrow('No PTY provider for connection "box-2"')
    expect(() => getProvider('runtime:env-1')).toThrow(PtyHostNotDispatchableError)
  })

  it('routes by the recorded owner first, then by the host the id names', () => {
    const relay = answeringProvider()
    registerSshPtyProvider('box 1', relay)

    setPtyOwnership('wt-1@@abcd1234', 'ssh:box%201')
    expect(getProviderForPty('wt-1@@abcd1234')).toBe(relay)
    expect(getPtySshConnectionId('wt-1@@abcd1234')).toBe('box 1')
    expect(getProviderForPty('ssh:box%201@@pty-1')).toBe(relay)

    unregisterSshPtyProvider('box 1')
    // Why: a detached relay keeps its PTYs attributed to it, never to this machine.
    expect(tryGetProviderForPty('ssh:box%201@@pty-1')).toBeUndefined()
    expect(hasPtyProviderForInspection('ssh:box%201@@pty-1')).toBe(false)
    expect(getPtySshConnectionId('ssh:box%201@@pty-1')).toBe('box 1')
  })
})
