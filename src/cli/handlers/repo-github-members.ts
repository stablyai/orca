import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GitHubParticipantSettingsStatus } from '../../shared/github/participant-accounts'
import { GitHubParticipantSave } from '../../shared/rpc-contract/github-participant-params'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { getRequiredStringFlag } from '../flags'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/types'

const memberFileSchema = GitHubParticipantSave.omit({ repo: true })

function requireServerOwnerConnection(ctx: HandlerContext): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    'GitHub member administration; run this command in the server owner shell.'
  )
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'GitHub member administration requires the local server owner connection. Run this command in the server shell.'
    )
  }
}

function formatMemberStatus(status: GitHubParticipantSettingsStatus): string {
  return [
    `Shared repo GitHub member policy: ${status.enabled ? 'enabled' : 'disabled'}`,
    status.error ? `Error: ${status.error}` : '',
    JSON.stringify(status, null, 2)
  ]
    .filter(Boolean)
    .join('\n')
}

async function readMemberFile(file: string) {
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      'Cannot read --file as JSON. Supply a readable member JSON file.'
    )
  }
  const parsed = memberFileSchema.safeParse(value)
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid member JSON. Expected only id (optional), name, deviceIds (string array), and allowedAccounts (array of {host, user}); no tokens or other fields.'
    )
  }
  return parsed.data
}

export const REPO_GITHUB_MEMBER_HANDLERS: Record<string, CommandHandler> = {
  'repo github-members': async ({ flags, client, json }) => {
    const result = await client.call<GitHubParticipantSettingsStatus>(
      'github.participants.status',
      {
        repo: getRequiredStringFlag(flags, 'repo')
      }
    )
    printResult(result, json, formatMemberStatus)
  },
  'repo github-member-save': async (ctx) => {
    requireServerOwnerConnection(ctx)
    const repo = getRequiredStringFlag(ctx.flags, 'repo')
    const member = await readMemberFile(resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'file')))
    const result = await ctx.client.call<GitHubParticipantSettingsStatus>(
      'github.participants.save',
      {
        repo,
        ...member
      }
    )
    printResult(result, ctx.json, formatMemberStatus)
  },
  'repo github-member-remove': async (ctx) => {
    requireServerOwnerConnection(ctx)
    const result = await ctx.client.call<GitHubParticipantSettingsStatus>(
      'github.participants.remove',
      {
        repo: getRequiredStringFlag(ctx.flags, 'repo'),
        id: getRequiredStringFlag(ctx.flags, 'id')
      }
    )
    printResult(result, ctx.json, formatMemberStatus)
  },
  'repo github-members-mode': async (ctx) => {
    requireServerOwnerConnection(ctx)
    const repo = getRequiredStringFlag(ctx.flags, 'repo')
    const mode = getRequiredStringFlag(ctx.flags, 'mode')
    if (mode !== 'enabled' && mode !== 'disabled') {
      throw new RuntimeClientError('invalid_argument', '--mode must be enabled or disabled.')
    }
    const result = await ctx.client.call<GitHubParticipantSettingsStatus>(
      'github.participants.setEnabled',
      {
        repo,
        enabled: mode === 'enabled'
      }
    )
    printResult(result, ctx.json, formatMemberStatus)
  }
}
