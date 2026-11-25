import type * as processHost from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { importClaudeTranscriptInWorker } from './journal-claude-import-worker'
import { useClaudeImportWorker } from './journal-claude-import-worker.test-fixture'
import { StructuredAgentSessionAcquireAborts } from '../../agent-session-wire/startup/structured-agent-session-acquire-aborts'

const child = vi.hoisted(() => ({
  spawned: Promise.withResolvers<{ pid: number; exited: Promise<unknown>; kill: () => unknown }>()
}))

vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof processHost>()
  return {
    ...actual,
    runProcess(spec: Parameters<typeof actual.runProcess>[0], capture?: 'head' | 'tail') {
      if (!spec.args?.[1]?.includes('unavailable directory verification')) {
        return actual.runProcess(spec, capture)
      }
      return actual.runProcess(
        {
          ...spec,
          launch() {
            const helper = actual.spawnProcess({
              ...spec,
              args: ['-e', 'setInterval(() => {}, 1000)']
            })
            const exited = once(helper, 'exit')
            child.spawned.resolve({
              pid: helper.pid!,
              exited,
              kill: () => helper.exitCode === null && helper.signalCode === null && helper.kill()
            })
            return { child: helper, withdrawPendingLaunch() {} }
          }
        },
        capture
      )
    }
  }
})

let root: string | undefined
let restoreHost: (() => void) | undefined
afterEach(async () => {
  restoreHost?.()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

type Stop = (
  acquisitions: StructuredAgentSessionAcquireAborts,
  acquisition: ReturnType<StructuredAgentSessionAcquireAborts['begin']>,
  worker: Worker
) => void | Promise<unknown>

it.each<[string, Stop]>([
  ['acquisition cancel', (_acquisitions, acquisition) => acquisition.abort()],
  ['quit', (acquisitions) => acquisitions.abortAll('quitting')],
  ['worker termination', (_acquisitions, _acquisition, worker) => worker.terminate()]
])('reaps the directory helper after %s', async (_reason, stop) => {
  child.spawned = Promise.withResolvers()
  root = await mkdtemp(join(tmpdir(), 'orca-claude-helper-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    JSON.stringify({
      uuid: 'row',
      type: 'user',
      sessionId: 'session',
      cwd: join(root, 'other'),
      message: { content: 'hello' }
    })
  )
  const acquisitions = new StructuredAgentSessionAcquireAborts()
  const acquisition = acquisitions.begin('session')
  let worker: Worker | undefined
  restoreHost = useClaudeImportWorker((started) => {
    worker = started
  })
  const importing = importClaudeTranscriptInWorker(
    {
      filePath,
      agent: 'claude',
      sessionId: 'session',
      signal: acquisition.signal,
      source: { providerSessionId: 'session', workspaceCwd: join(root, 'workspace') },
      limits: { inlineHeadBytes: 16384 },
      retainedBytes: 16384
    },
    async () => {
      throw new Error('Unexpected history page')
    }
  )
  const settled = expect(importing).rejects.toThrow(
    'The conversation directory could not be verified. Try Resume again.'
  )
  const helper = await Promise.race([
    child.spawned.promise,
    importing.then(() => {
      throw new Error('History import completed before directory validation')
    })
  ])
  try {
    expect(() => process.kill(helper.pid, 0)).not.toThrow()
    await stop(acquisitions, acquisition, worker!)
    await settled
    await helper.exited
    expect(() => process.kill(helper.pid, 0)).toThrow(/ESRCH/)
  } finally {
    acquisition.end()
    helper.kill()
  }
})
