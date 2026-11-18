import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_RECOVERY_CAPSULE_FILE } from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { interruptedRestart } from './structured-agent-session-restart-interruption.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'

afterEach(() => vi.restoreAllMocks())

it('leaves a chat cut while it asked its person for that person, continuing it only when asked', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const path = join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  const capsule = JSON.parse(await readFile(path, 'utf8'))
  capsule.entries[0].marker.activity = {
    state: 'blocked',
    prompts: [{ kind: 'approval', label: 'Run the migration' }],
    tasks: []
  }
  await writeFile(path, JSON.stringify(capsule))

  const automatic = await host.restartResume.continueAfterRestart(undefined, 'launch', undefined, {
    automatic: true
  })
  expect(automatic.continued).toEqual([])
  expect(dispatch).not.toHaveBeenCalled()
  expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])

  const asked = await host.restartResume.continueAfterRestart(undefined, 'modal')
  expect(asked.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
})
