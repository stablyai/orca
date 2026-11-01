import { mkdir, realpath, writeFile, rm, symlink, readFile } from 'node:fs/promises'
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (original) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await original<object>()),
    readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { adoptedDirectoryProbes } from '../agent-session-journal/adopted-directory-probe'
import { writeOpenCodeSqliteDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-fixture'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { structuredAgentsDeclaringNothing } from './structured-agent-session-adapter-router-test-support'
import { resolveAgentSessionLaunchDirectory } from '../../runtime/agent-session-launch-directory'
import { createClaudeStructuredLaunchResolver } from '../../runtime/structured-agent-launch-composition.test-support'

import { fixture } from './structured-agent-session-create-adoption-contract-test-fixture'

it.each([100, 1000])(
  'imports %s source rows into a linked workspace with one fresh probe and zero replay work',
  async (size) => {
    const physical = await realpath(fixture.rig.root)
    const registered = join(fixture.rig.root, 'registered')
    await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
    const transcriptPath = join(fixture.rig.root, `${THREAD}.jsonl`)
    // Captured CLI transcript metadata; relocate fixture identity/cwd into the isolated host.
    const captured = (
      await readFile(
        join(__dirname, '..', '__fixtures__', 'openclaude-0.31.0-local-command-rows.jsonl'),
        'utf8'
      )
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.type === 'user' && !row.isMeta)
    expect(captured.cwd).toBe('/tmp/project')
    await writeFile(
      transcriptPath,
      `${Array.from({ length: size }, (_, index) =>
        JSON.stringify({
          ...captured,
          uuid: `original-${index}`,
          sessionId: THREAD,
          cwd: physical,
          message: { role: 'user', content: 'original physical-keyed context' }
        })
      ).join('\n')}\n`
    )
    const params = createTestParams(undefined, {
      agent: 'claude',
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: fixture.rig.root },
      adopt: {
        providerHandle: claudeProviderHandle(THREAD, null),
        transcriptPath,
        source: { providerSessionId: THREAD, workspaceCwd: registered }
      }
    })
    const probe = vi.spyOn(adoptedDirectoryProbes, 'matches')
    const publishTab = vi.fn(async () => {
      expect(fixture.rig.store.getRecord(SESSION)?.providerHandleChain[0].handle.nativeId).toBe(
        THREAD
      )
    })
    const result = await fixture.rig.host.create(CALLER, params, { publishTab })
    expect(result).toMatchObject({
      ok: true,
      value: {
        page: {
          items: expect.arrayContaining([
            expect.objectContaining({
              body: expect.objectContaining({
                blocks: [{ type: 'text', text: 'original physical-keyed context' }]
              })
            })
          ])
        }
      }
    })
    expect(publishTab).toHaveBeenCalledOnce()
    expect(fixture.rig.store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
    expect(params.adopt?.source?.workspaceCwd).toBe(registered)
    const record = fixture.rig.store.getRecord(SESSION)!
    expect(
      await resolveAgentSessionLaunchDirectory(
        { store: fixture.rig.store, resolveWorkspacePath: async () => registered },
        record
      )
    ).toBe(registered)
    expect(record.providerHandleChain[0].handle.nativeId).toBe(THREAD)
    const hasTranscript = vi.fn(
      async ({
        providerSessionId,
        claudeConfigDir
      }: {
        providerSessionId: string
        claudeConfigDir: string
      }) =>
        providerSessionId === THREAD &&
        claudeConfigDir === fixture.rig.root &&
        (await readFile(transcriptPath, 'utf8')).includes(THREAD)
    )
    const launch = await createClaudeStructuredLaunchResolver({
      store: fixture.rig.store,
      resolveWorkspacePath: async () => registered,
      resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ account: 'system' }),
      resolveLaunchArgs: () => [],
      hasTranscript
    })({
      identity: {
        sessionId: SESSION,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent: 'claude',
        providerHandle: record.providerHandleChain[0].handle
      }
    })
    expect(launch).toMatchObject({
      cwd: registered,
      providerSessionId: THREAD,
      claudeConfigDir: fixture.rig.root,
      options: { resume: THREAD }
    })
    expect(hasTranscript).toHaveBeenCalledWith({
      providerSessionId: THREAD,
      claudeConfigDir: fixture.rig.root
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledOnce()
    await fixture.rig.host.flushAllStreamedEvents()
    await fixture.rig.restart()
    await rm(transcriptPath)
    expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(probe).toHaveBeenCalledOnce()
  }
)

it('uses current selected ancestors, then refuses retargeted/foreign sources before ownership', async () => {
  const physical = join(await realpath(fixture.rig.root), 'physical')
  const moved = join(await realpath(fixture.rig.root), 'moved')
  const registered = join(fixture.rig.root, 'registered')
  await mkdir(physical)
  await mkdir(moved)
  await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(moved, join(physical, 'pkg'), process.platform === 'win32' ? 'junction' : 'dir')
  const sourceCwd = join(physical, 'pkg')
  const workspaceCwd = join(registered, 'pkg')
  expect(await realpath(workspaceCwd)).toBe(moved)
  const transcriptPath = join(fixture.rig.root, `${THREAD}.jsonl`)
  const save = async (sessionId: string, cwd: string) =>
    writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'original',
        sessionId,
        cwd,
        message: { role: 'user', content: 'ancestor context' }
      })}\n`
    )
  const params = createTestParams(undefined, {
    agent: 'claude',
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: fixture.rig.root },
    adopt: {
      providerHandle: claudeProviderHandle(THREAD, null),
      transcriptPath,
      source: { providerSessionId: THREAD, workspaceCwd }
    }
  })
  const probe = vi.spyOn(adoptedDirectoryProbes, 'matches')
  await save('wrong-provider', sourceCwd)
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(probe).not.toHaveBeenCalled()
  await save(THREAD, join(fixture.rig.root, 'foreign'))
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(fixture.rig.store.listRecords()).toEqual([])
  await save(THREAD, sourceCwd)
  await rm(registered)
  await symlink(moved, registered, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(fixture.rig.store.listRecords()).toEqual([])
  await rm(registered)
  await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: true })
  expect(probe).toHaveBeenLastCalledWith(workspaceCwd, sourceCwd, expect.any(AbortSignal))
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: true, replayed: true })
})

it.each(['opencode', 'opencode2'] as const)(
  'commits %s actual database history using the same linked-cwd admission',
  async (agent) => {
    const definition = structuredAgentRuntimeRegistration(agent)!.definition
    await fixture.rig.dispose()
    fixture.rig = await createRestTestRig({
      agents: structuredAgentsDeclaringNothing([definition])
    })
    const physical = await realpath(fixture.rig.root)
    const registered = join(fixture.rig.root, 'registered')
    await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
    const transcriptPath = join(fixture.rig.root, 'opencode.db')
    writeOpenCodeSqliteDatabase(transcriptPath, [
      { id: THREAD, directory: physical, turns: [{ role: 'user', parts: ['database context'] }] }
    ])
    const params = createTestParams(undefined, {
      agent,
      provider: agent,
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
      adopt: {
        providerHandle: { agent, transport: definition.handleTransport, nativeId: THREAD },
        transcriptPath,
        source: { providerSessionId: THREAD, workspaceCwd: registered }
      }
    })
    expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.providerHandleChain[0].handle.nativeId).toBe(
      THREAD
    )
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  }
)
