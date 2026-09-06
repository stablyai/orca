import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileWebPackageProgress } from './MobileWebPackageProgress'

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))

describe('mobile web package progress', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('tells the user to stay in the app while bytes are still arriving', () => {
    act(() => {
      renderer = create(
        createElement(MobileWebPackageProgress, {
          progress: { phase: 'downloading', completedBytes: 30_720, totalBytes: 9_548_835 }
        })
      )
    })

    expect(renderedText()).toContain('Keep Orca open until this finishes.')
  })

  it('drops the stay-open warning once the transfer is done', () => {
    act(() => {
      renderer = create(
        createElement(MobileWebPackageProgress, {
          progress: { phase: 'verifying', completedBytes: 9_548_835, totalBytes: 9_548_835 }
        })
      )
    })

    expect(renderedText()).not.toContain('Keep Orca open')
  })

  function renderedText(): string {
    return JSON.stringify(renderer!.toJSON())
  }
})
