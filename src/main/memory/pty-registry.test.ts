import { afterEach, expect, it } from 'vitest'
import { listRegisteredPtys, registerPty, unregisterPty } from './pty-registry'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'

const nativeId = 'native-memory-owner'
const guestId = toAppWslPtyId({ distro: 'Ubuntu', relayBuildId: 'build' }, 'guest-owner')
afterEach(() => {
  unregisterPty(nativeId)
  unregisterPty(guestId)
})

it('does not attribute a guest PID collision to the Windows host process', () => {
  const entry = { pid: 1234, worktreeId: 'folder', sessionId: null, paneKey: null }
  registerPty({ ...entry, ptyId: nativeId })
  registerPty({ ...entry, ptyId: guestId })

  const rows = listRegisteredPtys().filter((row) => row.pid === 1234)
  expect(rows).toEqual([{ ...entry, ptyId: nativeId }])
})
