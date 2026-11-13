import { describe, expect, it } from 'vitest'
import {
  createLocalPtyInventoryReader,
  createLocalTmuxManagedPtyResolver
} from './local-tmux-managed-pty'
import type { PtyProcessInfo } from '../../providers/pty-provider-contract'

const row: PtyProcessInfo = {
  id: 'pty',
  incarnationId: 'generation',
  rootProcessId: 123,
  cwd: '/workspace',
  title: 'shell',
  worktreeId: 'folder:workspace'
}
describe.skipIf(process.platform === 'win32')('authenticated local tmux root resolution', () => {
  it('refuses a binding changed during capture and excludes WSL roots from a native probe', async () => {
    let binding = 'pty'
    const resolve = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({
        getPtyId: () => binding,
        listProcesses: async () => {
          binding = 'replacement'
          return [row]
        }
      })
    )
    expect(await resolve('pane')).toBeNull()
    const wsl = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({
        getPtyId: () => 'pty',
        listProcesses: async () => [{ ...row, wslDistro: 'Ubuntu-24.04' }]
      })
    )
    expect(await wsl('pane')).toBeNull()
  })
})
