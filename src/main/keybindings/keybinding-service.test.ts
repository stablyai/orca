import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeybindingService } from './keybinding-service'

describe('KeybindingService', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-keybinding-service-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps notifying listeners when one listener throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secondListener = vi.fn()
    const service = new KeybindingService({ homePath: dir, platform: 'linux' })
    service.onDidChange(() => {
      throw new Error('listener failed')
    })
    service.onDidChange(secondListener)

    expect(() => service.setActionBindings('terminal.search', ['Ctrl+Shift+F'])).not.toThrow()

    expect(secondListener).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[keybindings] change listener failed:', expect.any(Error))
    warn.mockRestore()
  })
})
