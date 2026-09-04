import { describe, expect, it, vi } from 'vitest'
import { listAllPages } from './cursor-pagination'

describe('listAllPages', () => {
  it('follows next_cursor until the data ends', async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => {
      const index = cursor ? Number(cursor) : 0
      return {
        results: [`item-${index}`],
        next_cursor: String(index + 1),
        next_page_results: index < 2
      }
    })
    await expect(listAllPages<string>(fetchPage)).resolves.toEqual({
      items: ['item-0', 'item-1', 'item-2'],
      truncated: false
    })
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('stops and reports truncation at maxItems', async () => {
    const fetchPage = vi.fn(async () => ({
      results: ['a', 'b', 'c'],
      next_cursor: 'next',
      next_page_results: true
    }))
    await expect(listAllPages<string>(fetchPage, { maxItems: 2 })).resolves.toEqual({
      items: ['a', 'b'],
      truncated: true
    })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('reports truncation when the page bound is hit', async () => {
    const fetchPage = vi.fn(async () => ({
      results: ['a'],
      next_cursor: 'next',
      next_page_results: true
    }))
    const result = await listAllPages<string>(fetchPage, { maxPages: 2, maxItems: 100 })
    expect(result.truncated).toBe(true)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('accepts a bare array, which small collections return', async () => {
    await expect(listAllPages<string>(async () => ['only'])).resolves.toEqual({
      items: ['only'],
      truncated: false
    })
  })

  it('treats a missing results field as an empty page', async () => {
    await expect(listAllPages<string>(async () => ({}))).resolves.toEqual({
      items: [],
      truncated: false
    })
  })
})

describe('truncation reporting', () => {
  it('does not claim truncation when the data ends exactly on the bound', async () => {
    // Regression: a project holding exactly maxItems rows reported truncated,
    // so the UI showed a false "results were cut off" banner.
    const fetchPage = vi.fn(async () => ({ results: ['a', 'b'], next_page_results: false }))
    await expect(listAllPages<string>(fetchPage, { maxItems: 2 })).resolves.toEqual({
      items: ['a', 'b'],
      truncated: false
    })
  })

  it('claims truncation when the bound is hit and more pages remain', async () => {
    const fetchPage = vi.fn(async () => ({
      results: ['a', 'b'],
      next_cursor: 'c2',
      next_page_results: true
    }))
    await expect(listAllPages<string>(fetchPage, { maxItems: 2 })).resolves.toEqual({
      items: ['a', 'b'],
      truncated: true
    })
  })
})
