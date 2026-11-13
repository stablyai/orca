import { expect, it } from 'vitest'
import { parseGitHubInstallRights } from './github-repo-ids'

it("reads gh's admin flag and owner type, and nothing else", () => {
  expect(parseGitHubInstallRights('true\nOrganization\n')).toEqual({
    admin: true,
    ownerType: 'Organization'
  })
  expect(parseGitHubInstallRights('false\nUser')).toEqual({ admin: false, ownerType: 'User' })
  // No permissions block (gh not signed in to this host) or an unknown owner type: can't tell.
  expect(parseGitHubInstallRights('null\nUser')).toBeNull()
  expect(parseGitHubInstallRights('true\nEnterprise')).toBeNull()
  expect(parseGitHubInstallRights('')).toBeNull()
})
