import { mkdir, realpath, writeFile, rm, symlink } from 'node:fs/promises'
vi.mock(
  '../../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async (original) => {
    const query =
      await import('../../../transcript-history/opencode/transcript-opencode-sqlite-query')
    return {
      ...(await original<object>()),
      readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
      readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
        query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
    }
  }
)
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import { HOST_TEST_THREAD as THREAD } from './structured-agent-session-host-test-data'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { adoptedDirectoryProbes } from '../../../agent-session-journal/history-import/adopted-directory-probe'

import { fixture } from './structured-agent-session-create-adoption-contract-test-fixture'

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
