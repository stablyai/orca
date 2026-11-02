import type { RpcResponse } from '../transport/types'
import type { MobileViewState } from './workspace-view-settings'
import { randomUUID } from 'expo-crypto'
import { resolveProjectPreferenceKey } from '../../../src/shared/project-preference-identity'
import {
  PERSONAL_PROJECT_ORDER_CAPABILITY,
  newerPersonalProjectOrder,
  type PersonalProjectOrder
} from '../../../src/shared/personal-project-order'
import type { ServedProjectSections } from './project-sections-operations'
import { projectOpenWrite, worktreeActivate } from '../host-screen/host-screen-operations'
import type { RpcClient } from '../transport/rpc-client'
import { readMirroredKeyOrStore } from '../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from './last-visited-worktree-repo'
import { readLastVisitedWorktreeOnHost } from './last-visited-worktree-by-host'
import type { Worktree } from './workspace-list-types'

const writer = randomUUID()
let seq = 0
const lastActivatedProject = new WeakMap<RpcClient, string>()

export async function captureMobilePersonalOpening(args: {
  hostId: string | undefined
  client: RpcClient | null
  capabilities: readonly string[]
  catalog: ServedProjectSections | null
  target: Worktree
  rows: readonly Worktree[]
}): Promise<(() => Promise<PersonalProjectOrder | undefined>) | null> {
  if (
    !args.client ||
    !args.hostId ||
    !args.capabilities.includes(PERSONAL_PROJECT_ORDER_CAPABILITY) ||
    !args.catalog ||
    args.target.workspaceKind === 'folder-workspace'
  ) {
    return null
  }
  const projectKey = resolveProjectPreferenceKey(
    args.target.repoId,
    args.catalog.setups,
    args.target.hostId ?? 'local'
  )
  if (!projectKey) {
    return null
  }
  const previous = readLastVisitedWorktreeOnHost(
    await readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY).catch(() => null),
    args.hostId
  )
  const previousRow = previous
    ? args.rows.find(
        (row) =>
          row.worktreeId === previous.worktreeId &&
          (row.hostId ?? 'local') === (previous.executionHost ?? 'local')
      )
    : undefined
  const storedPreviousProjectKey = previousRow
    ? resolveProjectPreferenceKey(
        previousRow.repoId,
        args.catalog.setups,
        previousRow.hostId ?? 'local'
      )
    : null
  const client = args.client
  const opId = { writer, seq: ++seq }
  let recorded: Promise<PersonalProjectOrder | undefined> | undefined
  return () => {
    if (recorded) {
      return recorded
    }
    const previousProjectKey = lastActivatedProject.get(client) ?? storedPreviousProjectKey
    lastActivatedProject.set(client, projectKey)
    recorded =
      projectKey === previousProjectKey
        ? Promise.resolve(undefined)
        : projectOpenWrite
            .request(client, { projectKey, previousProjectKey, opId })
            .then((reply) => {
              const result = projectOpenWrite.interpret(reply)
              if (!result.accepted) {
                throw new Error('project_open_refused')
              }
              return result.value.personalProjectOrder
            })
    return recorded
  }
}

export function isAcknowledgedWorkspaceActivation(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'activated' in value && value.activated === true
  )
}

export async function applyAcknowledgedMobilePersonalOpening(
  reply: RpcResponse,
  opening: (() => Promise<PersonalProjectOrder | undefined>) | null,
  state: {
    clientRef: { current: RpcClient | null }
    viewRef: { current: MobileViewState }
    setView: (view: MobileViewState) => void
  },
  client: RpcClient | null
): Promise<void> {
  const activation = worktreeActivate.interpret(reply)
  if (!activation.accepted || !isAcknowledgedWorkspaceActivation(activation.value)) {
    return
  }
  const order = await opening?.()
  if (!order || state.clientRef.current !== client) {
    return
  }
  const next = {
    ...state.viewRef.current,
    personalProjectOrder: newerPersonalProjectOrder(
      state.viewRef.current.personalProjectOrder,
      order
    )
  }
  state.viewRef.current = next
  state.setView(next)
}
