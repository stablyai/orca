import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isCodexSystemDefaultRealHomeEnabled } from './codex-real-home-flag'

const ENV_FLAG = 'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME'
let previousEnvFlag: string | undefined

beforeEach(() => {
  previousEnvFlag = process.env[ENV_FLAG]
  delete process.env[ENV_FLAG]
})

afterEach(() => {
  if (previousEnvFlag === undefined) {
    delete process.env[ENV_FLAG]
  } else {
    process.env[ENV_FLAG] = previousEnvFlag
  }
})

describe('isCodexSystemDefaultRealHomeEnabled', () => {
  it('is unconditionally ON in production (no settings consulted)', () => {
    expect(isCodexSystemDefaultRealHomeEnabled()).toBe(true)
  })

  it('lets the test-rig env override force ON explicitly', () => {
    for (const raw of ['1', 'true', 'on', 'TRUE', ' On ']) {
      process.env[ENV_FLAG] = raw
      expect(isCodexSystemDefaultRealHomeEnabled()).toBe(true)
    }
  })

  it('lets the test-rig env override pin the legacy managed lane OFF', () => {
    for (const raw of ['0', 'false', 'off']) {
      process.env[ENV_FLAG] = raw
      expect(isCodexSystemDefaultRealHomeEnabled()).toBe(false)
    }
  })

  it('ignores an unrecognized env value and stays ON', () => {
    process.env[ENV_FLAG] = 'maybe'
    expect(isCodexSystemDefaultRealHomeEnabled()).toBe(true)
  })
})
