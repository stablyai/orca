import {
  hostStatusProbe,
  readProbedHostCapabilities
} from '../transport/host-status-probe-operations'
import { randomUUID } from 'expo-crypto'
import { z } from 'zod'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { PERSONAL_PROJECT_ORDER_CAPABILITY } from '../../../src/shared/personal-project-order'
import { resolveProjectPreferenceKey } from '../../../src/shared/project-preference-identity'
import { projectOpenWrite } from '../host-screen/host-screen-operations'
import type { RpcClient } from '../transport/rpc-client'
import { readMirroredKeyOrStore } from '../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from './last-visited-worktree-repo'
import { readLastVisitedWorktreeOnHost } from './last-visited-worktree-by-host'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { projectSectionsRead } from './project-sections-operations'

const Intent = z.object({
  writer: z.string().uuid(),
  previousWorktreeId: z.string().nullable(),
  previousHost: z.string().nullable()
})

export async function createPersonalProjectRouteIntent(hostId: string): Promise<string> {
  const previous = readLastVisitedWorktreeOnHost(
    await readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY).catch(() => null),
    hostId
  )
  return JSON.stringify({
    writer: randomUUID(),
    previousWorktreeId: previous?.worktreeId ?? null,
    previousHost: previous?.executionHost ?? 'local'
  })
}

export async function recordPersonalProjectRouteIntent(args: {
  intent: string | undefined
  viewClient: RpcClient | null
  activation: unknown
  executionHost?: ExecutionHostId
}): Promise<void> {
  if (!args.intent || !args.viewClient) {
    return
  }
  const activation = z
    .object({ activated: z.literal(true), repoId: z.string() })
    .safeParse(args.activation)
  if (!activation.success) {
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(args.intent)
  } catch {
    return
  }
  const intent = Intent.safeParse(raw)
  if (!intent.success) {
    return
  }
  const capabilities = readProbedHostCapabilities(await hostStatusProbe.request(args.viewClient))
  if (!capabilities?.includes(PERSONAL_PROJECT_ORDER_CAPABILITY)) {
    return
  }
  const reply = await projectSectionsRead.request(args.viewClient)
  const catalog = projectSectionsRead.interpret(reply)
  if (!catalog.accepted || !catalog.value) {
    return
  }
  const projectKey = resolveProjectPreferenceKey(
    activation.data.repoId,
    catalog.value.setups,
    args.executionHost ?? 'local'
  )
  if (!projectKey) {
    return
  }
  const previousHost = normalizeExecutionHostId(intent.data.previousHost)
  const previousProjectKey =
    intent.data.previousWorktreeId && previousHost
      ? resolveProjectPreferenceKey(
          getRepoIdFromWorktreeId(intent.data.previousWorktreeId),
          catalog.value.setups,
          previousHost
        )
      : null
  await projectOpenWrite.request(args.viewClient, {
    projectKey,
    previousProjectKey,
    opId: { writer: intent.data.writer, seq: 0 }
  })
}
