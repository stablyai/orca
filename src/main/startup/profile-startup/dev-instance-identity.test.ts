import { expect, it } from 'vitest'
import { getDevInstanceIdentity } from './dev-instance-identity'

it("names a packaged profile app with the profile's display name and bundle id", () => {
  const profile = { name: 'Orca - Work', bundleId: 'com.stablyai.orca.profile.work' }
  expect(getDevInstanceIdentity(false, profile, {})).toMatchObject({
    name: 'Orca - Work',
    appName: 'Orca - Work',
    appUserModelId: 'com.stablyai.orca.profile.work'
  })
  expect(getDevInstanceIdentity(false, null, {})).toMatchObject({
    name: 'Orca',
    appUserModelId: 'com.stablyai.orca'
  })
})
