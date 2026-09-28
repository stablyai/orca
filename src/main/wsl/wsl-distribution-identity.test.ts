import { expect, it } from 'vitest'
import { parseWslDistributionIdentity } from './wsl-distribution-identity'
const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const guid = '{11111111-2222-3333-4444-555555555555}'
it('reads exact distro registration and refuses ambiguous or absent registrations', () => {
  const row = `${key}\\${guid}\r\n    DistributionName    REG_SZ    Ubuntu-24.04\r\n`
  expect(parseWslDistributionIdentity(row, 'Ubuntu-24.04')).toBe(guid)
  expect(parseWslDistributionIdentity(row, 'ubuntu-24.04')).toBe(guid)
  expect(parseWslDistributionIdentity(row, 'Ubuntu')).toBeNull()
  expect(
    parseWslDistributionIdentity(
      row + row.replace(guid, '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'),
      'Ubuntu-24.04'
    )
  ).toBeNull()
})
it('does not accept a same-named registry value outside the distribution key', () => {
  expect(
    parseWslDistributionIdentity(
      `HKEY_CURRENT_USER\\Elsewhere\\${guid}\n DistributionName REG_SZ Ubuntu`,
      'Ubuntu'
    )
  ).toBeNull()
})
