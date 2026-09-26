import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({ existsSync }))

import {
  getAppleSpeechHelperPath,
  isAppleSpeechDictationAvailable,
  resetAppleSpeechHelperPathCache
} from './apple-speech-helper-binary'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  resetAppleSpeechHelperPathCache()
  existsSync.mockReturnValue(true)
})

afterEach(() => {
  setPlatform(originalPlatform)
  resetAppleSpeechHelperPathCache()
})

describe('Apple Speech helper binary', () => {
  it('looks for the helper beside the app executable', () => {
    setPlatform('darwin')

    expect(getAppleSpeechHelperPath()).toContain('orca-speech-transcriber')
  })

  it('reports nothing off macOS, where the helper is never built', () => {
    setPlatform('win32')

    expect(getAppleSpeechHelperPath()).toBeNull()
    expect(isAppleSpeechDictationAvailable()).toBe(false)
  })

  it('reports nothing when swiftc never produced the helper', () => {
    setPlatform('darwin')
    existsSync.mockReturnValue(false)

    expect(getAppleSpeechHelperPath()).toBeNull()
    expect(isAppleSpeechDictationAvailable()).toBe(false)
  })
})
