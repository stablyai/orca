import { describe, expect, it } from 'vitest'
import { addOrcaWslInteropEnv } from './wsl-orca-env'

describe('addOrcaWslInteropEnv', () => {
  it('marks the Orca terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_wsl' }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u')
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p'
    }

    addOrcaWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:ORCA_TERMINAL_HANDLE/u:BAR/p')
  })
})
