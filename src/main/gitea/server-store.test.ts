import { describe, expect, it } from 'vitest'
import {
  deriveGiteaWebBaseUrl,
  getGiteaServerId,
  giteaServerHost,
  normalizeGiteaApiBaseUrl
} from './server-store'

describe('gitea server-store helpers', () => {
  it('normalizes API base URLs to the /api/v1 suffix', () => {
    expect(normalizeGiteaApiBaseUrl('https://git.example.com')).toBe(
      'https://git.example.com/api/v1'
    )
    expect(normalizeGiteaApiBaseUrl('https://git.example.com/')).toBe(
      'https://git.example.com/api/v1'
    )
    expect(normalizeGiteaApiBaseUrl('https://git.example.com/api/v1/')).toBe(
      'https://git.example.com/api/v1'
    )
  })

  it('derives the web base URL by stripping the API suffix', () => {
    expect(deriveGiteaWebBaseUrl('https://git.example.com/api/v1')).toBe('https://git.example.com')
    expect(deriveGiteaWebBaseUrl('https://git.example.com/code/api/v1')).toBe(
      'https://git.example.com/code'
    )
  })

  it('extracts a lowercase host from a server API base URL', () => {
    expect(giteaServerHost({ apiBaseUrl: 'https://Git.Example.com/api/v1' })).toBe(
      'git.example.com'
    )
    expect(giteaServerHost({ apiBaseUrl: 'not a url' })).toBeNull()
  })

  it('derives a stable, collision-resistant id per API base URL', () => {
    const id = getGiteaServerId('https://git.example.com/api/v1')
    expect(id).toHaveLength(24)
    expect(getGiteaServerId('https://git.example.com/api/v1')).toBe(id)
    expect(getGiteaServerId('https://other.example.com/api/v1')).not.toBe(id)
  })
})
