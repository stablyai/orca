import { describe, expect, it, vi } from 'vitest'

import { main } from './bootstrap-locale-catalog.mjs'

describe('bootstrap-locale-catalog', () => {
  it('rejects machine translation for Simplified Chinese', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main('/path/that/must/not/be-read', 'zh')).resolves.toBe(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Simplified Chinese is human-reviewed only')
    )

    consoleError.mockRestore()
  })
})
