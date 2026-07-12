import { afterEach, describe, expect, it, vi } from 'vitest'

const deviceMock = vi.hoisted(() => ({
  modelName: null as string | null
}))

const platformMock = vi.hoisted(() => ({
  OS: 'ios' as string,
  constants: {} as Record<string, string>
}))

vi.mock('expo-device', () => deviceMock)

vi.mock('react-native', () => ({
  Platform: platformMock
}))

import { resolveMobileDeviceDisplayName, sanitizeDeviceDisplayName } from './device-identity'

describe('sanitizeDeviceDisplayName', () => {
  it('trims and caps length', () => {
    expect(sanitizeDeviceDisplayName('  iPhone 15 Pro Max  ')).toBe('iPhone 15 Pro Max')
    expect(sanitizeDeviceDisplayName('x'.repeat(80))).toHaveLength(64)
  })

  it('caps by Unicode code point without splitting an emoji', () => {
    const sanitized = sanitizeDeviceDisplayName(`${'x'.repeat(63)}😀z`)

    expect(sanitized).toBe(`${'x'.repeat(63)}😀`)
    expect(Array.from(sanitized ?? '')).toHaveLength(64)
  })

  it('rejects empty / control-only strings', () => {
    expect(sanitizeDeviceDisplayName('   ')).toBeNull()
    expect(sanitizeDeviceDisplayName('\u0000\u0001')).toBeNull()
  })
})

describe('resolveMobileDeviceDisplayName', () => {
  afterEach(() => {
    platformMock.OS = 'ios'
    platformMock.constants = {}
    deviceMock.modelName = null
  })

  it('prefers iOS marketing model from expo-device', () => {
    platformMock.OS = 'ios'
    deviceMock.modelName = 'iPhone 15 Pro Max'
    expect(resolveMobileDeviceDisplayName()).toBe('iPhone 15 Pro Max')
  })

  it('falls back to iPhone when model is unavailable', () => {
    platformMock.OS = 'ios'
    deviceMock.modelName = null
    expect(resolveMobileDeviceDisplayName()).toBe('iPhone')
  })

  it('uses Android brand + model when present', () => {
    platformMock.OS = 'android'
    platformMock.constants = { Brand: 'Google', Model: 'Pixel 8' }
    expect(resolveMobileDeviceDisplayName()).toBe('Google Pixel 8')
  })

  it('avoids duplicating brand when model already includes it', () => {
    platformMock.OS = 'android'
    platformMock.constants = { Brand: 'Samsung', Model: 'Samsung Galaxy S24' }
    expect(resolveMobileDeviceDisplayName()).toBe('Samsung Galaxy S24')
  })
})
