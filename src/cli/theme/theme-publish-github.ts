import { runProcess } from '@orca/process-host'
import { RuntimeClientError } from '../runtime/connection/types'

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/** The GitHub user `gh` is signed in as, or null when gh is missing or signed out. */
export async function githubUser(): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'gh',
      args: ['api', 'user', '--jq', '.login'],
      timeoutMs: 15_000
    })
    const login = result.stdout.trim()
    return result.code === 0 && OWNER.test(login) ? login : null
  } catch {
    return null
  }
}

/** Organizations the signed-in user belongs to; empty when gh cannot list them. */
async function githubOrgs(): Promise<string[]> {
  try {
    const result = await runProcess({
      program: 'gh',
      args: ['api', '--paginate', 'user/orgs', '--jq', '.[].login'],
      timeoutMs: 15_000
    })
    return result.code === 0 ? result.stdout.split('\n').map((line) => line.trim()) : []
  } catch {
    return []
  }
}

/** Why: a typo'd or borrowed --repo must fail before anything is created, not after a commit. */
export async function assertOwnsRepository(owner: string): Promise<void> {
  const login = await githubUser()
  if (login === null) {
    throw new RuntimeClientError('invalid_argument', 'gh is not signed in to GitHub.', {
      nextSteps: ['Ask the user to run `gh auth login`, then publish again.']
    })
  }
  const allowed = [login, ...(await githubOrgs())].map((name) => name.toLowerCase())
  if (!allowed.includes(owner.toLowerCase())) {
    throw new RuntimeClientError(
      'invalid_argument',
      `GitHub user ${login} cannot publish to ${owner}: it is not them or one of their organizations.`,
      {
        nextSteps: [
          `Use --repo ${login}/<name>, or an organization ${login} belongs to.`,
          'If the organization is theirs, ask the user to run `gh auth refresh -s read:org`.'
        ]
      }
    )
  }
}

export function parseRepo(value: string | undefined): { owner?: string; name?: string } {
  if (value === undefined) {
    return {}
  }
  const parts = value.split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO.test(name) || /^\.+$/.test(name)) {
    throw new RuntimeClientError('invalid_argument', '--repo must look like owner/name.')
  }
  return { owner, name }
}
