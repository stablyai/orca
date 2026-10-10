import type {
  RuntimeReferenceFindResult,
  RuntimeReferenceListResult
} from '../../shared/runtime-reference-contracts'
import type { WorkspaceAttachment } from '../../shared/worktree/types'
import {
  getWorkspaceReferenceIdentifier,
  getWorkspaceReferenceIdentity,
  parseWorkspaceReferenceQuery
} from '../../shared/workspace-reference-identity'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { assertReferenceWritesSupported, parseReferenceUrls } from '../reference-input'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

// Why: hosts from before reference.* still advertise the linked-items delta capability, so the
// raw method_not_found would read as an Orca bug rather than a version gap.
async function callReference<TResult>(
  client: HandlerContext['client'],
  method: 'reference.list' | 'reference.find',
  params: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not support reference commands yet. Update Orca on the execution host.'
      )
    }
    throw error
  }
}

function workspaceTarget({ flags, client, cwd }: HandlerContext, required = true) {
  const selector = required
    ? getRequiredStringFlag(flags, 'worktree')
    : getOptionalStringFlag(flags, 'worktree')
  if (selector !== 'current' && selector !== 'active') {
    return {
      worktree: selector,
      ...(!client.isRemote && selector?.startsWith('path:') ? { cwd } : {})
    }
  }
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${selector} is a local cwd shortcut. Pass an explicit worktree selector on the remote host.`
    )
  }
  return { worktree: 'current', cwd }
}

function label(item: WorkspaceAttachment): string {
  return (
    item.url ??
    getWorkspaceReferenceIdentifier(item) ??
    `${item.provider}:${item.type}:${item.number}`
  )
}

function formatList(result: RuntimeReferenceListResult): string {
  return result.references.length
    ? result.references.map((item) => `${label(item)}\t${item.key}`).join('\n')
    : 'No linked references.'
}

function formatFind(result: RuntimeReferenceFindResult): string {
  const rows = result.matches.map(({ workspace, reference, agents }) => {
    const targets = agents.map(
      (agent) =>
        `  ${agent.linked ? 'linked' : 'workspace'} ${agent.liveness}${agent.terminal ? ` terminal=${agent.terminal}` : ''}${agent.mailbox ? ` mailbox=${agent.mailbox}` : ''}`
    )
    return [`${workspace.name}\t${workspace.id}\t${label(reference)}`, ...targets].join('\n')
  })
  if (result.truncated) {
    rows.push('More workspaces match. Increase --limit or narrow --repo/--worktree.')
  }
  return rows.join('\n') || 'No matching references.'
}

async function mutateReferences(context: HandlerContext, operation: 'add' | 'remove') {
  const { flags, client, json } = context
  const target = workspaceTarget(context)
  const input = parseReferenceUrls(getRepeatedStringFlag(flags, 'url'))
  const keys = operation === 'remove' ? getRepeatedStringFlag(flags, 'key') : []
  if (input.length === 0 && keys.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      operation === 'add' ? 'Pass at least one full URL.' : 'Pass at least one full URL or --key.'
    )
  }
  await assertReferenceWritesSupported(client)
  const before = await callReference<RuntimeReferenceListResult>(client, 'reference.list', target)
  const workspace = before.result.worktree
  const workspaceSelector = workspace.identity
    ? `identity:${workspace.identity.key}`
    : `id:${workspace.id}`
  const stored = before.result.references.map(({ key, selected: _selected, ...item }) => ({
    item,
    // Why: --key values come from the host's `reference list`; the CLI may be a different build.
    keys: new Set([key, getWorkspaceReferenceIdentity(item)])
  }))
  const base = stored.map(({ item }) => item)
  const isLinked = (key: string) => stored.some(({ keys }) => keys.has(key))
  const requestedKeys = new Set([...input.map(getWorkspaceReferenceIdentity), ...keys])
  const changes = [...requestedKeys].map((key) => {
    const changed = operation === 'add' ? !isLinked(key) : isLinked(key)
    return {
      key,
      operation,
      changed,
      ...(!changed ? { reason: operation === 'add' ? 'already_linked' : 'not_linked' } : {})
    }
  })
  if (changes.some((change) => change.changed)) {
    // Why: storage may hold same-URL twins with different source contexts; derive from `base`
    // so the host's delta merge never sees an unrequested twin as removed.
    // parseReferenceUrls already dedupes input by identity.
    const linkedItems =
      operation === 'add'
        ? [...base, ...input.filter((item) => !isLinked(getWorkspaceReferenceIdentity(item)))]
        : stored
            .filter(({ keys }) => ![...keys].some((key) => requestedKeys.has(key)))
            .map(({ item }) => item)
    const updates = {
      linkedItemsBase: base,
      linkedItems,
      linkedItemsSelectionChanged: false
    }
    await (workspace.kind === 'folder'
      ? client.call('folderWorkspace.update', {
          folderWorkspaceId: workspace.id.slice('folder:'.length),
          updates
        })
      : client.call('worktree.set', {
          worktree: workspaceSelector,
          ...updates
        }))
  }
  const result = await callReference<RuntimeReferenceListResult>(client, 'reference.list', {
    worktree: workspaceSelector
  })
  printResult({ ...result, result: { ...result.result, changes } }, json, () =>
    changes
      .map(({ key, changed, reason }) => `${operation}\t${changed ? 'changed' : reason}\t${key}`)
      .join('\n')
  )
}

export const REFERENCE_HANDLERS: Record<string, CommandHandler> = {
  'reference list': async (context) => {
    const result = await callReference<RuntimeReferenceListResult>(
      context.client,
      'reference.list',
      workspaceTarget(context)
    )
    printResult(result, context.json, formatList)
  },
  'reference add': (context) => mutateReferences(context, 'add'),
  'reference remove': (context) => mutateReferences(context, 'remove'),
  'reference find': async (context) => {
    const query = getRequiredStringFlag(context.flags, 'query')
    try {
      parseWorkspaceReferenceQuery(query)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : 'Invalid reference query.'
      )
    }
    const target = workspaceTarget(context, false)
    const repo = getOptionalStringFlag(context.flags, 'repo')
    if (target.worktree && repo) {
      throw new RuntimeClientError('invalid_argument', 'Pass --worktree or --repo, not both.')
    }
    const result = await callReference<RuntimeReferenceFindResult>(
      context.client,
      'reference.find',
      {
        query,
        ...target,
        repo,
        includeArchived: context.flags.get('include-archived') === true,
        limit: getOptionalPositiveIntegerFlag(context.flags, 'limit')
      }
    )
    printResult(result, context.json, formatFind)
  }
}
