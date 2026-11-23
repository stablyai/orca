import { expect, it } from 'vitest'
import {
  beginMacUpdateDownload,
  handleMacInstallerReady,
  isMacInstallerReady
} from './updater-mac-install'

it('requires current native staging for the version offered on normal quit', () => {
  const first = '1.4.273'
  const next = '1.4.274'

  beginMacUpdateDownload(first)
  expect(isMacInstallerReady(first)).toBe(false)

  handleMacInstallerReady(
    false,
    () => {},
    () => {}
  )
  expect(isMacInstallerReady(first)).toBe(true)
  expect(isMacInstallerReady(next)).toBe(false)

  beginMacUpdateDownload(next)
  expect(isMacInstallerReady(first)).toBe(false)
  expect(isMacInstallerReady(next)).toBe(false)

  handleMacInstallerReady(
    false,
    () => {},
    () => {}
  )
  expect(isMacInstallerReady(next)).toBe(true)
  expect(isMacInstallerReady(first)).toBe(false)
})
