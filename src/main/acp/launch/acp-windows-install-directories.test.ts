import { join } from 'node:path'
import { expect, it } from 'vitest'
import { windowsLocalAppDataBinDirectories } from './acp-windows-install-directories'

const home = join('C:', 'Users', 'me')

it('searches a redirected LOCALAPPDATA before the profile default', () => {
  expect(
    windowsLocalAppDataBinDirectories({ LocalAppData: ' D:\\Local ' }, home, 'qwen-code')
  ).toEqual([
    join('D:\\Local', 'qwen-code', 'bin'),
    join(home, 'AppData', 'Local', 'qwen-code', 'bin')
  ])
})

it('ignores a relative LOCALAPPDATA and keeps the default once', () => {
  const fallback = join(home, 'AppData', 'Local', 'agy', 'bin')
  expect(windowsLocalAppDataBinDirectories({ LOCALAPPDATA: 'Local' }, home, 'agy')).toEqual([
    fallback
  ])
  expect(
    windowsLocalAppDataBinDirectories({ LOCALAPPDATA: join(home, 'AppData', 'Local') }, home, 'agy')
  ).toEqual([fallback])
})
