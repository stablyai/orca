import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDevinHooksConfigText } from './hook-config-json'

describe('readDevinHooksConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-devin-jsonc-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects recovered partial parses from malformed JSONC', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseDevinHooksConfigText('{"hooks": }', 'Devin config.json')).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not parse Devin config.json')
      )
    } finally {
      warn.mockRestore()
    }
  })
})
