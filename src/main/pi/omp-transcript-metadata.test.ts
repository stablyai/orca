import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractAgentProviderSession } from '../../shared/agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from '../../shared/agent-launch/startup/agent-resume-argv'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-omp-metadata-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.each([
  ['dedicated OMP', { kind: 'omp' as const }],
  ['Pi-routed OMP', { kind: 'pi' as const, title: 'omp' }]
])('%s transcript metadata', (_name, args) => {
  it('resolves custom files without scanning and retains path-based resume across switches', async () => {
    const harness = createAgentStatusExtensionHarness(args)
    let id = ''
    let file = ''
    const sessionManager = { getSessionId: () => id, getSessionFile: () => file }
    for (const next of ['first', 'second']) {
      id = next
      file = join(root, `${id}.jsonl`)
      await writeFile(file, `${JSON.stringify({ type: 'session', id })}\n`)
      await harness.callHook('agent_start', undefined, {
        sessionManager
      })
      await vi.waitFor(() =>
        expect(harness.fetchMock).toHaveBeenCalledTimes(id === 'first' ? 1 : 2)
      )
      const payload = JSON.parse(String(harness.fetchMock.mock.lastCall?.[1]?.body)).payload
      const session = extractAgentProviderSession('omp', payload)
      expect(session).toEqual({ key: 'session_id', id, transcriptPath: file })
      expect(getAgentResumeArgv('omp', session!)).toEqual(['omp', '--resume', file])
      expect(getAgentResumeArgv('omp', session!, 'explicit.jsonl')).toEqual([
        'omp',
        '--resume',
        'explicit.jsonl'
      ])
      await expect(
        resolveSessionFilePath('omp', id, {
          transcriptPath: session!.transcriptPath,
          ompSessionsDir: join(root, 'unused-default')
        })
      ).resolves.toBe(file)
    }
    expect(harness.fsMock.existsSync).not.toHaveBeenCalled()
  })

  it('publishes planned persistent paths, then resolves after delayed creation', async () => {
    const harness = createAgentStatusExtensionHarness(args)
    const file = join(root, 'delayed.jsonl')
    await harness.callHook('agent_start', undefined, {
      sessionManager: { getSessionId: () => 'delayed', getSessionFile: () => file }
    })
    const payload = JSON.parse(String(harness.fetchMock.mock.lastCall?.[1]?.body)).payload
    const session = extractAgentProviderSession('omp', payload)!
    expect(session.transcriptPath).toBe(file)
    const options = { transcriptPath: session.transcriptPath, ompSessionsDir: join(root, 'empty') }
    await expect(resolveSessionFilePath('omp', session.id, options)).resolves.toBeNull()
    await writeFile(file, '{}\n')
    await expect(resolveSessionFilePath('omp', session.id, options)).resolves.toBe(file)
    const controller = new AbortController()
    controller.abort()
    await expect(
      resolveSessionFilePath('omp', session.id, options, controller.signal)
    ).rejects.toThrow()
  })
})
