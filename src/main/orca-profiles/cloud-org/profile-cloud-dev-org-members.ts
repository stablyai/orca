import type {
  OrcaOrgMember,
  OrcaOrgMembersRoster,
  OrcaOrgPendingInvite
} from '../../../shared/orca-profiles/orca-profiles'

// With no dev-auth server, this roster mirrors real membership states (the console manages it).
type DevOrgRoster = {
  members: OrcaOrgMember[]
  pendingInvites: OrcaOrgPendingInvite[]
}

const devRostersByOrg = new Map<string, DevOrgRoster>()
const MAX_DEV_ORG_ROSTERS = 64

function cleanEnvString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function devSelf(): OrcaOrgMember {
  return {
    userId: cleanEnvString(process.env.ORCA_CLOUD_DEV_USER_ID, 'dev-user'),
    email: cleanEnvString(process.env.ORCA_CLOUD_DEV_EMAIL, 'dev@orca.local'),
    displayName: cleanEnvString(process.env.ORCA_CLOUD_DEV_DISPLAY_NAME, 'Orca Dev'),
    role: 'owner',
    mfa: 'on'
  }
}

function seedDevRoster(): DevOrgRoster {
  return {
    members: [
      devSelf(),
      {
        userId: 'dev-teammate-1',
        email: 'teammate@orca.local',
        displayName: 'Dev Teammate',
        role: 'admin',
        mfa: 'off'
      },
      // Null user IDs exercise members who have not signed in yet.
      {
        userId: null,
        email: 'invited-member@orca.local',
        displayName: undefined,
        role: 'member',
        mfa: 'off'
      }
    ],
    pendingInvites: [{ email: 'pending@orca.local', role: 'member', createdAt: Date.now() }]
  }
}

function getDevRoster(orgId: string): DevOrgRoster {
  const existing = devRostersByOrg.get(orgId)
  if (existing) {
    return existing
  }
  const seeded = seedDevRoster()
  devRostersByOrg.set(orgId, seeded)
  while (devRostersByOrg.size > MAX_DEV_ORG_ROSTERS) {
    const oldest = devRostersByOrg.keys().next()
    if (oldest.done) {
      break
    }
    devRostersByOrg.delete(oldest.value)
  }
  return seeded
}

export function listDevOrcaCloudOrgMembers(orgId: string): OrcaOrgMembersRoster {
  const roster = getDevRoster(orgId)
  return {
    members: roster.members.map((member) => ({ ...member })),
    pendingInvites: roster.pendingInvites.map((invite) => ({ ...invite })),
    viewerRole: 'owner',
    canManageMembers: true
  }
}
