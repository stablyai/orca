import type { WorkspaceAttachment } from '../shared/worktree/types'
import type { RuntimeStatus } from '../shared/runtime-types'
import { WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY } from '../shared/workspace-attachment-capabilities'
import {
  getWorkspaceReferenceIdentity,
  parseWorkspaceReferenceUrl
} from '../shared/workspace-reference-identity'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { getRepeatedStringFlag } from './flags'

export function parseReferenceUrls(urls: string[]): WorkspaceAttachment[] {
  try {
    const references = urls.map((url) => parseWorkspaceReferenceUrl(url))
    return [
      ...new Map(references.map((item) => [getWorkspaceReferenceIdentity(item), item])).values()
    ]
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : 'Pass a full issue or review URL.'
    )
  }
}

export async function assertReferenceWritesSupported(client: RuntimeClient): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot merge reference changes safely. Update Orca on the execution host.'
    )
  }
}

export function getCreateReferences(
  flags: Map<string, string | boolean>
): WorkspaceAttachment[] | undefined {
  if (!flags.has('reference')) {
    return undefined
  }
  const legacy = ['issue', 'pr', 'linear-issue', 'gitlab-issue', 'gitlab-mr'].find((name) =>
    flags.has(name)
  )
  if (legacy) {
    throw new RuntimeClientError('invalid_argument', `Cannot combine --reference with --${legacy}.`)
  }
  const urls = getRepeatedStringFlag(flags, 'reference')
  if (urls.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--reference requires a full issue or review URL.'
    )
  }
  return parseReferenceUrls(urls)
}
