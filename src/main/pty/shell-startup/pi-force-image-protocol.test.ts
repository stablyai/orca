import { describe, expect, it } from 'vitest'
import {
  PI_FORCE_IMAGE_PROTOCOL_ENV,
  PI_FORCE_IMAGE_PROTOCOL_VALUE
} from '../../../../shared/terminal/images/terminal-image-protocol'

describe('PI image protocol env', () => {
  it('names the env oh-my-pi gates image rendering on (#39536)', () => {
    expect(PI_FORCE_IMAGE_PROTOCOL_ENV).toBe('PI_FORCE_IMAGE_PROTOCOL')
    expect(PI_FORCE_IMAGE_PROTOCOL_VALUE).toBe('kitty')
  })
})
