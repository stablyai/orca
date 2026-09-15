import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractAgentProviderSession, getAgentResumeArgv } from '../../shared/agent-session-resume'
import type * as SessionScannerDiscovery from '../ai-vault/session-scanner-discovery'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

vi.mock('../ai-vault/session-scanner-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionScannerDiscovery>()
  return { ...actual, walkSessionFiles: vi.fn(actual.walkSessionFiles) }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-omp-metadata-'))
  vi.mocked(walkSessionFiles).mockClear()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.each([
  ['dedicated OMP', { kind: 'omp' as const }],
  ['Pi-routed OMP', { kind: 'pi' as const, title: 'omp' }]
])('%s transcript metadata', (_name, args) => {
  it('resolves custom files without scanning and retains id-based resume across switches', async () => {
    const harness = createAgentStatusExtensionHarness(args)
    for (const id of ['first', 'second']) {
      const file = join(root, `${id}.jsonl`)
      await writeFile(file, `${JSON.stringify({ type: 'session', id })}\n`)
      await harness.callHook('agent_start', undefined, {
        sessionManager: { getSessionId: () => id, getSessionFile: () => file }
      })
      await vi.waitFor(() =>
        expect(harness.fetchMock).toHaveBeenCalledTimes(id === 'first' ? 1 : 2)
      )
      const payload = JSON.parse(String(harness.fetchMock.mock.lastCall?.[1]?.body)).payload
      const session = extractAgentProviderSession('omp', payload)
      expect(session).toEqual({ key: 'session_id', id, transcriptPath: file })
      expect(getAgentResumeArgv('omp', session!)).toEqual(['omp', '--resume', id])
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
    expect(walkSessionFiles).not.toHaveBeenCalled()
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
    expect(walkSessionFiles).toHaveBeenCalledTimes(1)
    await writeFile(file, '{}\n')
    vi.mocked(walkSessionFiles).mockClear()
    await expect(resolveSessionFilePath('omp', session.id, options)).resolves.toBe(file)
    expect(walkSessionFiles).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(
      resolveSessionFilePath('omp', session.id, options, controller.signal)
    ).rejects.toThrow()
    expect(walkSessionFiles).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 123])(
    'clears persistent metadata for ephemeral path %s',
    async (file) => {
      const harness = createAgentStatusExtensionHarness(args)
      await harness.callHook('agent_start', undefined, {
        sessionManager: {
          getSessionId: () => 'persistent',
          getSessionFile: () => join(root, 'p.jsonl')
        }
      })
      await harness.callHook('agent_end', undefined, {
        sessionManager: { getSessionId: () => 'ephemeral', getSessionFile: () => file }
      })
      await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
      const payload = JSON.parse(String(harness.fetchMock.mock.lastCall?.[1]?.body)).payload
      expect(payload).toEqual({ hook_event_name: 'agent_end' })
      expect(extractAgentProviderSession('omp', payload)).toBeNull()
    }
  )
})

it('retains id-based discovery with an old extension and rejects malformed optional paths', async () => {
  const id = 'legacy-session'
  const file = join(root, `${id}.jsonl`)
  await writeFile(file, '{}\n')
  for (const session_file of [undefined, '', 123, '/bad\npath.jsonl']) {
    const session = extractAgentProviderSession('omp', { session_id: id, session_file })!
    expect(session).toEqual({ key: 'session_id', id })
    expect(getAgentResumeArgv('omp', session)).toEqual(['omp', '--resume', id])
    await expect(resolveSessionFilePath('omp', id, { ompSessionsDir: root })).resolves.toBe(file)
  }
  expect(walkSessionFiles).toHaveBeenCalledTimes(4)
})
