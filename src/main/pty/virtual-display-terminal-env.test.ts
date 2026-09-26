import { describe, expect, it } from 'vitest'
import {
  ORCA_VIRTUAL_DISPLAY_ENV,
  removeOrcaVirtualDisplayEnv
} from './virtual-display-terminal-env'

describe('removeOrcaVirtualDisplayEnv', () => {
  it("drops DISPLAY when it still names Orca's own virtual display", () => {
    const env = { DISPLAY: ':99', [ORCA_VIRTUAL_DISPLAY_ENV]: ':99', HOME: '/home/user' }

    removeOrcaVirtualDisplayEnv(env, undefined)

    expect(env).toEqual({ HOME: '/home/user' })
  })

  it('keeps a DISPLAY that differs from the virtual display Orca adopted', () => {
    const env = { DISPLAY: ':0', [ORCA_VIRTUAL_DISPLAY_ENV]: ':99' }

    removeOrcaVirtualDisplayEnv(env, undefined)

    expect(env).toEqual({ DISPLAY: ':0' })
  })

  it('keeps DISPLAY when no virtual display marker is present', () => {
    const env = { DISPLAY: ':99' }

    removeOrcaVirtualDisplayEnv(env, undefined)

    expect(env).toEqual({ DISPLAY: ':99' })
  })

  it('keeps a DISPLAY the spawn request asked for explicitly', () => {
    const env = { DISPLAY: ':99', [ORCA_VIRTUAL_DISPLAY_ENV]: ':99' }

    removeOrcaVirtualDisplayEnv(env, { DISPLAY: ':99' })

    expect(env).toEqual({ DISPLAY: ':99' })
  })
})
