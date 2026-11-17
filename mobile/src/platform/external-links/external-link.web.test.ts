import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openExternalLink, publishExternalLinkOpener } from './external-link.web'

let warned: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warned.mockRestore()
})

describe('opening a URL from inside the shell', () => {
  it('hands an allowed URL to whatever the entry published', () => {
    const asked: string[] = []
    publishExternalLinkOpener((url) => {
      asked.push(url)
      return true
    })
    openExternalLink('https://github.com/stablyai/orca')
    expect(asked).toEqual(['https://github.com/stablyai/orca'])
    expect(warned).not.toHaveBeenCalled()
  })
})
