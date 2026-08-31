import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { safeParseWorkspaceSession } from '../../shared/workspace-session-schema'
import { journalDirectoryFor } from '../native-chat/agent-session-journal/journal-paths'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { AGENT_SESSION_STORE_FILE_NAME } from './agent-session-record-store-file'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'

const WORKSPACE = 'workspace-1'
const SESSION = 'session-alpha-1'

function structuredTab() {
  return {
    id: `agent-session:${SESSION}`,
    entityId: SESSION,
    groupId: 'group-1',
    worktreeId: WORKSPACE,
    contentType: 'agent-session' as const,
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function profileWithStructuredTab(): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKSPACE,
    activeTabId: structuredTab().id,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: { [WORKSPACE]: structuredTab().id },
    unifiedTabs: { [WORKSPACE]: [structuredTab()] }
  }
}

/** The pinned base rejects the new discriminator and salvages the remaining profile. */
function pinnedBaseRoundTrip(raw: Record<string, unknown>): Record<string, unknown> {
  const unifiedTabs = raw.unifiedTabs as Record<string, unknown[]> | undefined
  return {
    ...raw,
    ...(unifiedTabs
      ? {
          unifiedTabs: Object.fromEntries(
            Object.entries(unifiedTabs).map(([worktreeId, tabs]) => [
              worktreeId,
              tabs.filter((tab) => {
                const contentType = (tab as { contentType?: unknown }).contentType
                return (
                  contentType === 'terminal' ||
                  contentType === 'editor' ||
                  contentType === 'diff' ||
                  contentType === 'conflict-review' ||
                  contentType === 'check-details' ||
                  contentType === 'browser' ||
                  contentType === 'simulator'
                )
              })
            ])
          )
        }
      : {})
  }
}

let root: string

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('structured session rollback compatibility', () => {
  it('keeps the visible session reference through target → base → target', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-structured-rollback-'))
    const storeDir = join(root, 'agent-store')
    await mkdir(storeDir, { recursive: true })
    const record = agentSessionRecordFixture({
      ...agentSessionRecordFixture().lease,
      sessionId: SESSION,
      runtimeKind: 'native'
    })
    await writeFile(
      join(storeDir, AGENT_SESSION_STORE_FILE_NAME),
      JSON.stringify({
        schemaVersion: 2,
        hostId: 'local',
        records: { [SESSION]: record },
        operations: {},
        retiredClaimKeys: [],
        unusableRecords: {}
      })
    )
    const journalDir = journalDirectoryFor(root, { workspaceId: WORKSPACE, sessionId: SESSION })
    await mkdir(journalDir, { recursive: true })
    await writeFile(join(journalDir, 'journal.log'), 'durable-journal-fixture\n')

    const target = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    expect(target.getVisibleSessionTabIndex()).toEqual({ present: false, sessionIds: [] })
    await target.setSessionTabVisibility(SESSION, true)
    expect(target.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: [SESSION] })

    const targetProfile = profileWithStructuredTab()
    const targetParsed = safeParseWorkspaceSession(targetProfile)
    expect(targetParsed?.success).toBe(true)
    expect(
      collectSavedStructuredAgentSessionIds(targetParsed?.success ? targetParsed.data : null)
    ).toEqual([SESSION])

    const baseProfile = pinnedBaseRoundTrip(targetProfile)
    const baseParsed = safeParseWorkspaceSession(baseProfile)
    expect(baseParsed?.success).toBe(true)
    expect(
      collectSavedStructuredAgentSessionIds(baseParsed?.success ? baseParsed.data : null)
    ).toEqual([])

    await writeFile(join(root, 'profile.json'), JSON.stringify(baseProfile))
    const targetReloadedProfile = safeParseWorkspaceSession(JSON.parse(JSON.stringify(baseProfile)))
    expect(targetReloadedProfile?.success).toBe(true)
    expect(
      collectSavedStructuredAgentSessionIds(
        targetReloadedProfile?.success ? targetReloadedProfile.data : null
      )
    ).toEqual([])
    const reloaded = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    expect(reloaded.listVisibleSessionIds()).toEqual([SESSION])
    expect(reloaded.getRecord(SESSION)?.providerHandleChain).toHaveLength(1)
    await expect(readFile(join(journalDir, 'journal.log'), 'utf8')).resolves.toBe(
      'durable-journal-fixture\n'
    )
    expect(
      JSON.parse(await readFile(join(storeDir, AGENT_SESSION_STORE_FILE_NAME), 'utf8'))
    ).toMatchObject({ visibleSessionIds: [SESSION] })

    await reloaded.setSessionTabVisibility(SESSION, false)
    const afterClose = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    expect(afterClose.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: [] })
    expect(afterClose.listVisibleSessionIds()).toEqual([])
    expect(afterClose.getRecord(SESSION)?.providerHandleChain).toHaveLength(1)
  })
})
