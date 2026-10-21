import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isOpenCodeLegacySharedConfigDir } from './legacy-shared-config-dir'

describe('retired config directory recognition', () => {
  const root = join(process.cwd(), 'user-data')
  it.each(['opencode-hooks', 'opencode2-hooks'])('normalizes %s paths', (hooks) => {
    const path = join(root, hooks, 'shared')
    expect(isOpenCodeLegacySharedConfigDir(`${path}/`, root)).toBe(true)
    expect(isOpenCodeLegacySharedConfigDir(`${path}/../shared`, root)).toBe(true)
    expect(isOpenCodeLegacySharedConfigDir(`${path}/../mine`, root)).toBe(false)
    expect(isOpenCodeLegacySharedConfigDir(`${path}-custom`, root)).toBe(false)
    expect(isOpenCodeLegacySharedConfigDir(undefined, root)).toBe(false)
  })
  it.skipIf(process.platform !== 'win32')('handles Windows casing and separators', () => {
    expect(isOpenCodeLegacySharedConfigDir('C:/ORCA/opencode-hooks/shared/', 'c:\\orca')).toBe(true)
  })
})

describe('isOpenCodeLegacySharedConfigDir', () => {
  const userData = join('fixture', 'user-data')

  it('matches only the retired shared dirs of both OpenCode variants', () => {
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode-hooks', 'shared'), userData)
    ).toBe(true)
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode2-hooks', 'shared'), userData)
    ).toBe(true)
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode-hooks', 'mine'), userData)
    ).toBe(false)
    expect(
      isOpenCodeLegacySharedConfigDir(join('other', 'opencode-hooks', 'shared'), userData)
    ).toBe(false)
    expect(isOpenCodeLegacySharedConfigDir(undefined, userData)).toBe(false)
  })
})
