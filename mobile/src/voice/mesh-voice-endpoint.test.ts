import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MESH_VOICE_HOST,
  extractMeshHost,
  kokoroDirectBaseUrlFor,
  meshVoiceBaseUrlFor
} from './mesh-voice-endpoint'

describe('mesh-voice-endpoint', () => {
  describe('extractMeshHost', () => {
    it('returns the hostname of a ws URL', () => {
      expect(extractMeshHost('ws://100.92.56.51:6768/path')).toBe('100.92.56.51')
    })

    it('returns the hostname of an http URL', () => {
      expect(extractMeshHost('http://node-a.tailnet:6768/')).toBe('node-a.tailnet')
    })

    it('preserves the host of a wss URL on a non-default port', () => {
      expect(extractMeshHost('wss://mesh.local:8443')).toBe('mesh.local')
    })

    it('returns a bare host string when the input is not a URL', () => {
      expect(extractMeshHost('100.92.56.51')).toBe('100.92.56.51')
    })

    it('returns null for nullish or whitespace input', () => {
      expect(extractMeshHost(null)).toBeNull()
      expect(extractMeshHost(undefined)).toBeNull()
      expect(extractMeshHost('')).toBeNull()
      expect(extractMeshHost('   ')).toBeNull()
    })

    it('returns null for a URL that has no hostname', () => {
      // Why: a malformed URL is treated as "no host known" so the caller falls
      // back to the default rather than synthesising a bogus URL.
      expect(extractMeshHost('not a url at all')).toBeNull()
    })
  })

  describe('meshVoiceBaseUrlFor', () => {
    it('builds the LiteLLM proxy URL on the supplied host', () => {
      expect(meshVoiceBaseUrlFor('ws://node-b.tailnet:6768')).toBe(
        'http://node-b.tailnet:4000'
      )
    })

    it('falls back to the documented default when no host is supplied', () => {
      expect(meshVoiceBaseUrlFor(null)).toBe(`http://${DEFAULT_MESH_VOICE_HOST}:4000`)
      expect(meshVoiceBaseUrlFor(undefined)).toBe(`http://${DEFAULT_MESH_VOICE_HOST}:4000`)
    })

    it('falls back to the default when the host is unparseable', () => {
      expect(meshVoiceBaseUrlFor('not a url at all')).toBe(
        `http://${DEFAULT_MESH_VOICE_HOST}:4000`
      )
    })
  })

  describe('kokoroDirectBaseUrlFor', () => {
    it('builds the Kokoro-direct URL on the supplied host', () => {
      expect(kokoroDirectBaseUrlFor('ws://node-c.tailnet:6768')).toBe(
        'http://node-c.tailnet:8880'
      )
    })

    it('falls back to the documented default when no host is supplied', () => {
      expect(kokoroDirectBaseUrlFor(null)).toBe(
        `http://${DEFAULT_MESH_VOICE_HOST}:8880`
      )
    })
  })
})
