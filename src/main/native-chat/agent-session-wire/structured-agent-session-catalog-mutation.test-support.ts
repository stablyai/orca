import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { modelCatalogHostDeps } from '../../runtime/structured-agent-model-catalog-wiring'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { closeTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { readPersistedTestAgentSessionStore } from '../../runtime/agent-session-record-store-test-harness'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import {
  type RestTestRig,
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION
} from './structured-agent-session-rest-test-rig'

export const CLAUDE_MODEL = 'claude-opus-5-5[1m]'
export const CODEX_MODEL = 'gpt-5.4'

export async function catalogMutationDeadline<T>(work: Promise<T>, boundary: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${boundary} did not settle within 2000ms`)),
          2_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Stop test-owned resources without joining a deliberately failed conversation cycle. */
export async function disposeCatalogMutationHost(rig: RestTestRig): Promise<void> {
  // A failed lock-cycle contract cannot use graceful quit, which joins that same delivery tail.
  rig.host.stopDelivery()
  const { lifetime, runtimeState, sessions } = rig.host.collaboratorsForTests()
  lifetime.dispose()
  rig.host.deps.modelCatalog?.stop()
  try {
    await catalogMutationDeadline(
      (async () => {
        await runtimeState.stopLeaseRenewal()
        await runtimeState.flushAllEventSinks()
        await Promise.all([...sessions.values()].map((session) => session.journal.close()))
        sessions.clear()
        rig.host['clientDelivery'].closeAll()
      })(),
      'fixture resource drain'
    )
  } finally {
    closeTestJournalHostDatabase(rig.root)
  }
}

/** Only external adapter/probe IO is scripted; catalog installation and session owners are real. */
export async function createCatalogMutationFixture(
  stateDirectory: string,
  agent: 'claude' | 'codex'
) {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  const dispose = async () => {
    try {
      await disposeCatalogMutationHost(rig)
    } finally {
      await rm(rig.root, { recursive: true, force: true })
    }
  }
  try {
    const home = {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: join(rig.root, agent)
    }
    const model = agent === 'claude' ? CLAUDE_MODEL : CODEX_MODEL
    const probe = vi.fn(async (): Promise<never> => {
      throw new Error('saved catalog reads must not launch discovery')
    })
    const definition = rig.host.deps.agents.definition(agent)
    if (!definition) {
      throw new Error(`missing real ${agent} definition`)
    }
    const installed = await modelCatalogHostDeps({
      store: rig.store,
      agents: rig.host.deps.agents,
      registrations: [
        {
          definition,
          modelCatalog: () => ({
            kind: 'probe',
            listingNamesConfiguredModel: agent === 'codex',
            probe
          })
        }
      ],
      host: () => rig.host,
      deps: {
        stateDirectory,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => rig.root,
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'system' }),
        resolveAgentAccountHome: async () => home,
        logger: rig.host.deps.logger
      },
      environment: {
        resolveBaseEnvironment: async () => ({}),
        resolveAgentEnvironment: async () => ({}),
        refreshAfterMissingProgram: async () => {},
        bindCatalogSources: () => () => {}
      }
    })
    const catalog = installed.modelCatalog
    if (!catalog) {
      throw new Error('runtime catalog was not installed')
    }
    rig.host.deps.modelCatalog = catalog
    rig.host.deps.launchAccountHome = async () => home
    const fingerprint = agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null }),
      rig.root
    )
    agentModelCatalogStore.recordSuccess(
      fingerprint,
      agent,
      {
        models: [
          { id: model, label: model, isDefault: true, efforts: [{ value: 'high', label: 'High' }] }
        ],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
    const created = await catalogMutationDeadline(
      rig.host.create(
        CALLER,
        createTestParams(undefined, {
          agent,
          provider: agent,
          accountHome: home
        })
      ),
      'at-rest fixture creation'
    )
    expect(created).toMatchObject({ ok: true })
    expect(rig.store.requireWritableRecord(SESSION).lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(
      await catalogMutationDeadline(
        catalog.prepareSaved({
          agent,
          sessionId: SESSION,
          inSessionWorkspace: true,
          verifiedOnly: true
        }),
        'external catalog fixture preflight'
      )
    ).toMatchObject({ origin: 'probe', models: [{ id: model }] })

    const request = (key: string, value: string) => ({
      key,
      value,
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: rig.store.requireWritableRecord(SESSION).lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields: { key, value }
        })
      }
    })
    return {
      rig,
      home,
      model,
      catalog,
      probe,
      request,
      persisted: () => readPersistedTestAgentSessionStore(rig.root),
      dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
