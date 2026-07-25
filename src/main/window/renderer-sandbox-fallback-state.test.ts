import { afterEach, describe, expect, it } from 'vitest'
import {
  isRendererSandboxFallbackActive,
  setRendererSandboxFallbackActive
} from './renderer-sandbox-fallback-state'

afterEach(() => {
  setRendererSandboxFallbackActive(false)
})

describe('renderer-sandbox-fallback-state', () => {
  it('defaults to inactive', () => {
    expect(isRendererSandboxFallbackActive()).toBe(false)
  })

  it('reflects the last set value', () => {
    setRendererSandboxFallbackActive(true)
    expect(isRendererSandboxFallbackActive()).toBe(true)
    setRendererSandboxFallbackActive(false)
    expect(isRendererSandboxFallbackActive()).toBe(false)
  })
})
