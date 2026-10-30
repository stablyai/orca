import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorSource } from './connector-adapter.js'
import { saveIdentity } from './connector-identities.js'

// The options every source's `link` command takes, beside its workspace flag.
export const LINK_OPTIONS = {
  user: { type: 'string' },
  account: { type: 'string' },
  'default-host': { type: 'string' },
  'default-project': { type: 'string' },
  'channel-project': { type: 'string', multiple: true }
} as const

export type LinkValues = {
  user?: string
  account?: string
  'default-host'?: string
  'default-project'?: string
  'channel-project'?: string[]
}

export function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`--${flag} is required`)
  }
  return value
}

// Operator seeding (no sign-in in v1): which Orca account a source's user is, with their
// machine-choice defaults. `checkId` rejects anything that isn't one of the source's ids.
export async function linkIdentity(
  database: CloudDatabase,
  input: {
    source: ConnectorSource
    workspaceId: string
    values: LinkValues
    checkId: (value: string | undefined, flag: string) => string
  },
  now: number
): Promise<string> {
  const { values, checkId } = input
  const containerProjects = Object.fromEntries(
    (values['channel-project'] ?? []).map((entry) => {
      const [channel, project] = entry.split('=', 2)
      return [checkId(channel, 'channel-project'), required(project, 'channel-project')]
    })
  )
  const userId = checkId(values.user, 'user')
  await saveIdentity(
    database,
    {
      source: input.source,
      workspaceId: input.workspaceId,
      userId,
      accountId: required(values.account, 'account'),
      defaultHostId: values['default-host'] ?? null,
      defaultProject: values['default-project'] ?? null,
      containerProjects
    },
    now
  )
  return `Linked ${userId} in ${input.workspaceId}.`
}
