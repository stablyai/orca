import { describe, expect, it } from 'vitest'
import {
  browserUserDataDir,
  nativeMessagingManifestPath,
  windowsRegistryHostKey
} from './native-messaging-host-paths'

describe('nativeMessagingManifestPath', () => {
  it('darwin chrome NativeMessagingHosts', () => {
    expect(
      nativeMessagingManifestPath({
        browser: 'chrome',
        platform: 'darwin',
        homeDir: '/Users/u',
        userDataPath: '/data'
      })
    ).toBe(
      '/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.orca.chatimport.json'
    )
  })
  it('linux chromium NativeMessagingHosts', () => {
    expect(
      nativeMessagingManifestPath({
        browser: 'chromium',
        platform: 'linux',
        homeDir: '/home/u',
        userDataPath: '/d'
      })
    ).toBe('/home/u/.config/chromium/NativeMessagingHosts/com.orca.chatimport.json')
  })
  it('win32 lives under userData/chat-import', () => {
    expect(
      nativeMessagingManifestPath({
        browser: 'chrome',
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        userDataPath: 'C:\\data'
      }).replace(/\\/g, '/')
    ).toBe('C:/data/chat-import/com.orca.chatimport.json')
  })
})
describe('browserUserDataDir', () => {
  it('darwin brave base dir', () => {
    expect(browserUserDataDir({ browser: 'brave', platform: 'darwin', homeDir: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/BraveSoftware/Brave-Browser'
    )
  })
  it('linux chrome base dir', () => {
    expect(browserUserDataDir({ browser: 'chrome', platform: 'linux', homeDir: '/home/u' })).toBe(
      '/home/u/.config/google-chrome'
    )
  })
})
describe('windowsRegistryHostKey', () => {
  it('edge hive', () => {
    expect(windowsRegistryHostKey('edge')).toBe(
      'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.orca.chatimport'
    )
  })
})
