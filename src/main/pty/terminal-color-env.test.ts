import { describe, expect, it } from 'vitest'
import { removeInheritedNoColor } from './terminal-color-env'

describe('terminal color env', () => {
  it('removes inherited color-disable variables from spawned terminal env', () => {
    const env = {
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
      TERM: 'xterm-256color'
    }

    removeInheritedNoColor(env)

    expect(env).toEqual({ TERM: 'xterm-256color' })
  })

  it('preserves explicit color-enable variables', () => {
    const env = {
      FORCE_COLOR: '1',
      CLICOLOR: '1'
    }

    removeInheritedNoColor(env)

    expect(env).toEqual({
      FORCE_COLOR: '1',
      CLICOLOR: '1'
    })
  })
})
