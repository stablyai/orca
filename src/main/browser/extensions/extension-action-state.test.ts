import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ nativeImage: {} }))

const { parseBadgeColor } = await import('./extension-action-state')

describe('parseBadgeColor', () => {
  it('takes both forms chrome.action accepts', () => {
    expect(parseBadgeColor([1, 2, 3])).toEqual([1, 2, 3, 255])
    expect(parseBadgeColor([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
    expect(parseBadgeColor('#0f8')).toEqual([0, 255, 136, 255])
    expect(parseBadgeColor('#123456')).toEqual([18, 52, 86, 255])
  })

  it('rejects anything else', () => {
    expect(() => parseBadgeColor('red')).toThrow()
    expect(() => parseBadgeColor([1, 'x', 3])).toThrow()
  })
})
