import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { InProcessAgentIdentityClient } from '../../../identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../../identity/agent-identity-worker-client'
import { AgentHookServer } from '../../agent-hook-server'
import { LastStatusStore } from '../../last-status-store'
import type { LastStatusFile } from '../../server-types'
import { buildBody } from '../server.test-fixtures'

const WSL = 'wsl:Ubuntu'
const PANE = makePaneKey('tab-0', '00000000-0000-4000-8000-000000000000')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function stopHook(sessionId: string) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      { hook_event_name: 'Stop', session_id: sessionId, prompt: 'task 0' },
      { paneKey: PANE, tabId: 'tab-0' }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

/** Restarts from the saved status document without a disk round trip. */
class RestartingServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  constructor(private readonly saved?: LastStatusFile) {
    super()
  }

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }

  savedStatus(): LastStatusFile {
    return this.buildStatusFile()
  }

  protected override getStatusStore(): LastStatusStore | null {
    const saved = this.saved
    const path = this.lastStatusPath
    if (!saved || !path) {
      return super.getStatusStore()
    }
    return new (class extends LastStatusStore {
      override read() {
        return { document: saved, source: 'rows' as const }
      }
    })(path)
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-agent-places-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function started<T extends AgentHookServer>(server: T, dir: string): Promise<T> {
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: dir })
  cleanups.unshift(server.subscribeStatusChanges(() => {}))
  return server
}

/** Lets the identity worker's queued answers arrive and re-stamp their rows. */
const answered = () => new Promise((resolve) => setImmediate(resolve))

it('names a finished sleeping place for show, before and after a restart', async () => {
  const dir = tempDir()
  const first = await started(new RestartingServer(), dir)
  first.ingestRemote(stopHook('session-0'), WSL)
  await answered()
  const id = first.getStatusSnapshot()[0]?.orcaSessionId
  first.setTerminalPaneLifecycle({
    ownsProcess: (key, pty) => key === PANE && pty === 'sleeping-pty',
    isStopping: () => true,
    isReversibleStop: (pty) => pty === 'sleeping-pty',
    isPlaced: () => true
  })
  expect(first.settleTerminalPaneSleep(PANE, 'sleeping-pty')).toBe(true)
  const sleepingPlace = [
    { paneKey: 'tab-0:00000000-0000-4000-8000-000000000000', worktreeId: 'wt-1' }
  ]
  expect(await first.terminalAgentPlaces(id!, { includeSleeping: true })).toEqual(sleepingPlace)

  const saved = first.savedStatus()
  first.stop()
  const restarted = await started(new RestartingServer(saved), dir)
  await answered()
  expect(await restarted.terminalAgentPlaces(id!, { includeSleeping: true })).toEqual(sleepingPlace)
})
