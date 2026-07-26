import { describe, expect, it } from 'vitest'
import { relayEndpointForHost } from './ssh-relay-endpoints'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SOCK_NAME = 'relay-1234567890abcdef.sock'

function asciiEndpointWithLength(byteLength: number): { remoteDir: string; sockName: string } {
  return {
    remoteDir: `/${'a'.repeat(byteLength - Buffer.byteLength(SOCK_NAME, 'utf8') - 2)}`,
    sockName: SOCK_NAME
  }
}

describe('ssh-relay-endpoints', () => {
  describe('relayEndpointForHost', () => {
    it('keeps Linux paths at the 107-byte limit', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const { remoteDir, sockName } = asciiEndpointWithLength(107)
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).toBe(`${remoteDir}/${sockName}`)
      expect(Buffer.byteLength(result, 'utf8')).toBe(107)
    })

    it('shortens Linux paths above the 107-byte limit', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const { remoteDir, sockName } = asciiEndpointWithLength(108)
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).not.toBe(`${remoteDir}/${sockName}`)
      expect(result).toMatch(/relay-1234567890abcdef\.sock$/)
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(107)
    })

    it('keeps Darwin paths at the 103-byte limit and shortens 104 bytes', () => {
      const hostPlatform = getRemoteHostPlatform('darwin-arm64')
      const atLimit = asciiEndpointWithLength(103)
      const overLimit = asciiEndpointWithLength(104)

      expect(relayEndpointForHost(hostPlatform, atLimit.remoteDir, atLimit.sockName)).toBe(
        `${atLimit.remoteDir}/${atLimit.sockName}`
      )
      const shortened = relayEndpointForHost(hostPlatform, overLimit.remoteDir, overLimit.sockName)
      expect(shortened).not.toBe(`${overLimit.remoteDir}/${overLimit.sockName}`)
      expect(Buffer.byteLength(shortened, 'utf8')).toBeLessThanOrEqual(103)
    })

    it('measures non-ASCII paths in UTF-8 bytes', () => {
      const hostPlatform = getRemoteHostPlatform('darwin-x64')
      const remoteDir = `/${'é'.repeat(38)}`
      const fullPath = `${remoteDir}/${SOCK_NAME}`

      expect(fullPath.length).toBeLessThanOrEqual(103)
      expect(Buffer.byteLength(fullPath, 'utf8')).toBeGreaterThan(103)
      const shortened = relayEndpointForHost(hostPlatform, remoteDir, SOCK_NAME)
      expect(shortened).not.toBe(fullPath)
      expect(Buffer.byteLength(shortened, 'utf8')).toBeLessThanOrEqual(103)
    })

    it('keeps version isolation when shortening into the relay parent directory', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const remoteDir = `/home/user/.orca-remote/relay-${'v'.repeat(100)}`
      const result = relayEndpointForHost(hostPlatform, remoteDir, SOCK_NAME)

      expect(result).toMatch(
        /^\/home\/user\/\.orca-remote\/[a-f0-9]{12}-relay-1234567890abcdef\.sock$/
      )
    })

    it('falls back to a target-identifiable /tmp path if the parent path is too long', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const remoteDir = `/${'a'.repeat(100)}/.orca-remote/relay-v1`
      const result = relayEndpointForHost(hostPlatform, remoteDir, SOCK_NAME)
      expect(result).toMatch(/^\/tmp\/orca-[a-f0-9]{12}-relay-1234567890abcdef\.sock$/)
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(107)
    })

    it('returns the complete Windows named pipe format', () => {
      const hostPlatform = getRemoteHostPlatform('win32-x64')
      const remoteDir = 'C:/Users/user/.orca-remote/relay'
      const sockName = 'relay.sock'
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).toMatch(/^\\\\\.\\pipe\\orca-relay-[a-f0-9]{20}$/)
    })
  })
})
