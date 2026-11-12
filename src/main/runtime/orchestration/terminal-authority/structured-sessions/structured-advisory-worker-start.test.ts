import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import * as sessionCreate from '../../../rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { resultOf } from '../../../rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  call,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  request,
  root,
  runtime
} from './structured-chat-coordinator-mail-rig.test-fixture'

it.each(['unsupported', 'git-workspace', 'nonempty-folder', 'admitted', 'cold-host'])(
  'enforces %s consultation admission before actor launch',
  async (reason) => {
    await openChat(COORDINATOR)
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const { taskId } = await coordinatorRunAndTask()
    const path = join(root, 'advisor')
    await mkdir(path)
    if (reason === 'nonempty-folder') {
      await writeFile(join(path, 'CLAUDE.md'), 'Unadmitted context')
    }
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockImplementation(async () => {
      if (reason === 'cold-host') {
        setStructuredAgentSessionHost(null)
      }
      return { supported: true }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture uses only the launch settings and the resolved workspace identity/path.
    vi.spyOn(runtime, 'requireStore').mockReturnValue({
      getSettings: () => ({
        nativeChatProviders: EVERY_AGENT_CHAT,
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only these host-resolved workspace fields.
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: reason === 'git-workspace' ? 'repo::git' : 'folder:advisor',
      repoId: 'repo',
      path,
      hostId: 'local'
    } as never)
    vi.spyOn(host.deps.adapter, 'supportsAdvisoryPolicy').mockReturnValue(reason !== 'unsupported')
    const create = vi
      .spyOn(sessionCreate, 'createStructuredAgentSessionForWorktree')
      .mockRejectedValue(new Error('Unexpected actor creation.'))
    if (reason === 'cold-host') {
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(async () => {
        setStructuredAgentSessionHost(host)
      })
    }
    const response = await dispatcher.dispatch(
      request(
        'orchestration.workerStart',
        {
          spec: 'Which admitted evidence distinguishes the two hypotheses?',
          parent: taskId,
          worktree: 'id:folder:advisor',
          agent: 'claude',
          model: 'test-model',
          effort: 'medium',
          advisoryPolicy: {
            schema: 1,
            dataScope: 'published',
            sourcePin: 'a'.repeat(40),
            deadlineAt: 1_800_000_030_000,
            maxModelCalls: 4,
            artifacts: [
              {
                path: 'note.txt',
                text: 'hello',
                sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
              }
            ]
          }
        },
        { sessionId: COORDINATOR }
      )
    )
    if (reason === 'admitted' || reason === 'cold-host') {
      expect(response.ok).toBe(true)
      const receipt = resultOf(response)
      expect(receipt.state).toBe('failed')
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          advisoryPolicy: expect.objectContaining({
            dataScope: 'published',
            maxModelCalls: 4,
            artifacts: [
              {
                path: 'note.txt',
                text: 'hello',
                sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
              }
            ]
          }),
          options: { model: 'test-model', effort: 'medium' },
          atRest: true
        })
      )
      expect(db.getTask(String(receipt.taskId))?.parent_id).toBe(taskId)
      const shown = await call(
        'orchestration.workerShow',
        { dispatch: receipt.dispatchId },
        { sessionId: COORDINATOR }
      )
      expect(shown).toMatchObject({
        worker: {
          startOptions: { advisoryPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }
        }
      })
      expect(JSON.stringify(shown)).not.toContain('"text":"hello"')
      return
    }
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_unconfigured', data: { effectsApplied: false } }
    })
    expect(create).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(taskId)).toEqual([])
  }
)
