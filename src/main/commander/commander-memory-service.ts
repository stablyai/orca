import { createHash } from 'node:crypto'
import { canUpdateRecovery, recoveryActorId, type RecoveryEntry } from './commander-recovery-entry'
import { z } from 'zod'
import { readMemoryIndex, readWorkerGuidance } from './commander-memory-index'
import {
  commanderAccount,
  commanderAgentGrantRequest,
  commanderRecurringAnswerChange,
  commanderRecurringAnswerSetting,
  commanderMemoryHistory,
  commanderMemoryId,
  commanderMemoryList,
  commanderMemoryPage,
  commanderPreferenceResult,
  commanderMemoryWrite,
  type CommanderAccount,
  type CommanderMemoryIndexQuery,
  type CommanderMemoryWrite,
  type CommanderMemoryRevision,
  type CommanderMemoryApi
} from '../../shared/commander/memory-contract'
import { cloudConnectLinkEpoch } from '../orca-profiles/cloud-auth/profile-cloud-connect-attempts'
import { readInitializedActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import { takeCloudSessionTicket } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

type RequestMemory = (path: string, body?: unknown, delegation?: string) => Promise<unknown>

async function withCommanderAccount<T>(
  expected: CommanderAccount,
  run: (request: RequestMemory, assertCurrent: () => void) => Promise<T>,
  beforeRequest?: () => Promise<void>
): Promise<T> {
  const account = commanderAccount.parse(expected)
  const directory = getProfileUserDataPath()
  const epoch = cloudConnectLinkEpoch()
  const ticket = takeCloudSessionTicket(account.profileId, directory)
  const active = await readInitializedActiveOrcaProfile(directory)
  function assertCurrent(): void {
    const currentTicket = takeCloudSessionTicket(account.profileId, directory)
    if (
      cloudConnectLinkEpoch() !== epoch ||
      ticket.linkVersion !== currentTicket.linkVersion ||
      ticket.generation !== currentTicket.generation
    ) {
      throw new Error('Commander account changed. Reopen the memory page.')
    }
  }
  function verifyProfile(profile: typeof active.profile): void {
    assertCurrent()
    if (
      profile.id !== account.profileId ||
      profile.cloud?.userId !== account.userId ||
      (profile.cloud?.activeOrgId ?? null) !== account.activeOrgId
    ) {
      throw new Error('Commander account changed. Reopen the memory page.')
    }
  }
  verifyProfile(active.profile)
  const config = getOrcaCloudAuthConfig()
  if (!config.configured) {
    throw new Error('Orca Cloud sign-in is not configured.')
  }
  const operation = await runWithFreshOrcaCloudSession(
    config.config,
    active,
    directory,
    async (session) => {
      const request: RequestMemory = async (path, body, delegation) => {
        await beforeRequest?.()
        assertCurrent()
        const url = new URL(`/v1/commander/memory${path}`, config.config.apiBaseUrl)
        const response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${delegation ?? session.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(20_000)
        })
        if (!response.ok) {
          await cancelUnreadResponseBody(response)
          if (response.status === 409) {
            throw new Error('Commander memory version conflict. Reload the latest revision.')
          }
          if (response.status === 401 && delegation) {
            throw new Error('Commander delegation expired or was rejected.')
          }
          throw new OrcaCloudRequestError(response.status)
        }
        const result: unknown = await response.json()
        assertCurrent()
        return result
      }
      return run(request, assertCurrent)
    }
  )
  verifyProfile((await readInitializedActiveOrcaProfile(directory)).profile)
  if (operation.status !== 'ok') {
    throw new Error('Reconnect your Orca account to access Commander memory.')
  }
  return operation.value
}

export async function mintCommanderAgentGrant(account: CommanderAccount, raw: unknown) {
  const { projectId, agentId, type = 'agent' } = commanderAgentGrantRequest.parse(raw)
  return withCommanderAccount(account, async (request, assertCurrent) => {
    const grant = z
      .object({ token: z.string().startsWith('orcacmd_'), expiresAt: z.string() })
      .parse(await request('/delegations', { type, id: agentId, projectId }))
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      throw new Error('Orca Cloud sign-in is not configured.')
    }
    return {
      assertCurrent,
      grant: {
        ...grant,
        url: new URL('/v1/commander/memory', config.config.apiBaseUrl).href,
        projectId,
        actorId: agentId,
        type
      }
    }
  })
}

export function recurringAnswersSetting(
  account: CommanderAccount,
  change?: z.infer<typeof commanderRecurringAnswerChange>,
  beforeRequest?: () => Promise<void>
) {
  const write = commanderRecurringAnswerChange.optional().parse(change)
  return withCommanderAccount(
    account,
    async (request) =>
      commanderRecurringAnswerSetting.parse(await request('/preferences/settings', write)),
    beforeRequest
  )
}

export function askHomeMemoryPreference(
  account: CommanderAccount,
  botId: string,
  projectId: string,
  question: string,
  requestId: string,
  assertLaunch: () => void
) {
  return withCommanderAccount(
    account,
    async (request) => {
      const { token } = z
        .object({ token: z.string().startsWith('orcacmd_') })
        .parse(await request('/delegations', { type: 'commander', id: botId, projectId }))
      return commanderPreferenceResult.parse(
        await request(
          '/preferences/ask',
          { expectedProjectId: projectId, expectedActorType: 'commander', question, requestId },
          token
        )
      )
    },
    async () => assertLaunch()
  )
}

export function saveCommanderMemory(
  account: CommanderAccount,
  write: CommanderMemoryWrite,
  beforeRequest?: () => Promise<void>
) {
  return withCommanderAccount(
    account,
    async (request) =>
      commanderMemoryPage.parse(await request('/human', commanderMemoryWrite.parse(write))),
    beforeRequest
  )
}

function indexMemory(
  account: CommanderAccount,
  query: CommanderMemoryIndexQuery,
  beforeRequest?: () => Promise<void>
) {
  return withCommanderAccount(account, (request) => readMemoryIndex(request, query), beforeRequest)
}

type CloudMemoryOperations = Pick<
  CommanderMemoryApi,
  'list' | 'get' | 'save' | 'checkpoint' | 'workerGuidance'
> & {
  index: typeof indexMemory
}

export const commanderMemoryService: CloudMemoryOperations = {
  index: indexMemory,
  workerGuidance: (account, projectId) =>
    withCommanderAccount(account, (request) => readWorkerGuidance(request, projectId)),
  list: (account) =>
    withCommanderAccount(account, async (request) => commanderMemoryList.parse(await request(''))),
  get: (account, pageId, beforeVersion) =>
    withCommanderAccount(account, async (request) => {
      const cursor = z.number().int().positive().optional().parse(beforeVersion)
      const query = cursor === undefined ? '' : `?beforeVersion=${cursor}`
      return commanderMemoryHistory.parse(
        await request(`/pages/${commanderMemoryId.parse(pageId)}${query}`)
      )
    }),
  save: saveCommanderMemory,
  checkpoint: (account, raw) =>
    withCommanderAccount(account, async (request) => {
      const write = commanderMemoryWrite.parse(raw)
      if (
        write.deleted ||
        write.kind !== 'note' ||
        !write.projectId ||
        !/^checkpoint-[0-9a-f]{64}$/.test(write.pageId)
      ) {
        throw new Error('Invalid project checkpoint.')
      }
      const { token } = z.object({ token: z.string().min(1) }).parse(
        await request('/delegations', {
          type: 'commander',
          id: 'orca-checkpoint',
          projectId: write.projectId
        })
      )
      return commanderMemoryPage.parse(await request('/commander', write, token))
    })
}

/** Main-process-only publication. A stale consent/account cannot authorize a later upload. */
export async function publishRecoveryMemory(
  account: CommanderAccount,
  entry: RecoveryEntry,
  beforeRequest: () => Promise<void>
): Promise<'synced' | 'protected'> {
  return withCommanderAccount(
    account,
    async (request) => {
      let page: CommanderMemoryRevision | undefined
      try {
        page = commanderMemoryPage.parse(
          await request(`/pages/${entry.pageId}?beforeVersion=1`)
        ).page
      } catch (err) {
        if (!(err instanceof OrcaCloudRequestError && err.statusCode === 404)) {
          throw err
        }
      }
      if (page && !canUpdateRecovery(page, entry)) {
        return 'protected'
      }
      if (page?.body === entry.body) {
        return 'synced'
      }
      const expectedVersion = page?.version ?? 0
      const write = {
        ...entry,
        title: page?.title ?? entry.title,
        expectedVersion,
        requestId: createHash('sha256')
          .update(JSON.stringify([entry, expectedVersion]))
          .digest('hex'),
        kind: 'note',
        links: []
      }
      const { token } = z.object({ token: z.string().min(1) }).parse(
        await request('/delegations', {
          type: 'commander',
          id: recoveryActorId,
          projectId: entry.projectId
        })
      )
      commanderMemoryPage.parse(await request('/commander', write, token))
      return 'synced'
    },
    beforeRequest
  )
}
