import { afterEach, expect, it } from 'vitest'
import { createUnavailablePtyProvider } from '../../../providers/unavailable-pty-provider'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import {
  getLocalPtyProvider,
  getProviderForPty,
  hasPtyProviderForInspection,
  registerWslPtyProvider,
  tryGetProviderForAgentSessionOwner
} from './registry'
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
})
it('routes exact guest identity while retaining legacy Windows daemon IDs', () => {
  const owner = { distro: 'Ubuntu', relayBuildId: 'version+hash' }
  const provider = createUnavailablePtyProvider()
  releases.push(registerWslPtyProvider(owner, provider))
  const id = toAppWslPtyId(owner, 'pty2:guest:1')
  expect(getProviderForPty(id)).toBe(provider)
  expect(tryGetProviderForAgentSessionOwner(id)).toBe(provider)
  expect(hasPtyProviderForInspection(id)).toBe(true)
  expect(getProviderForPty('pty2:windows:1')).toBe(getLocalPtyProvider())
  releases.pop()?.()
  expect(() => getProviderForPty(id)).toThrow('not connected')
  expect(tryGetProviderForAgentSessionOwner(id)).toBeUndefined()
  expect(hasPtyProviderForInspection(id)).toBe(false)
})
it('never falls through to Windows for malformed or foreign guest identity', () => {
  expect(() => getProviderForPty('wsl:broken')).toThrow('Invalid WSL')
  expect(() =>
    getProviderForPty(toAppWslPtyId({ distro: 'Debian', relayBuildId: 'old' }, 'pty2:guest:1'))
  ).toThrow('not connected')
})
