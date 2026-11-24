import { expect, it } from 'vitest'
import { isOnNetworkVolume } from './worktree-git-common-network-volume'

it('treats Windows UNC paths as network volumes and drive paths as local', async () => {
  expect(await isOnNetworkVolume('\\\\server\\share\\repo\\.git', 'win32')).toBe(true)
  expect(await isOnNetworkVolume('//server/share/repo/.git', 'win32')).toBe(true)
  expect(await isOnNetworkVolume('C:\\src\\repo\\.git', 'win32')).toBe(false)
  expect(await isOnNetworkVolume('/Volumes/share/repo/.git', 'darwin')).toBe(false)
})
