import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { collectBundle } from '../../observability/bundle'
import { createLocalFileSink } from '../../observability/local-file-sink'
import { setActiveSink } from '../../observability/tracer'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { GROK, openAcpAdapterRig } from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  setActiveSink(null)
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

it.each(['initialize', 'session/new', 'authenticate'])(
  'keeps a live %s rejection and stderr in the startup failure',
  async (method) => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('antigravity')!,
      initialize: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] },
      script: (agent) => {
        if (method === 'authenticate') {
          agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Sign in'))
        }
        agent.on(method, (frame) => {
          rig.child().stderr = 'harness: Permission denied {"token":"stderr-private"}'
          agent.fail(frame, -32603, 'Internal error', {
            details: '{"error":"Cannot execute localharness","authorization":"Bearer rpc-private"}'
          })
        })
      }
    })
    await rig.acquire()
    expect(rig.openVerdict()).toMatchObject({
      retry: 'never',
      cause: {
        name: 'AcpAgentError',
        code: -32603,
        data: {
          details: '{"error":"Cannot execute localharness","authorization":"Bearer rpc-private"}'
        }
      },
      fact: {
        kind: 'startFailed',
        detail: {
          audience: 'log',
          text: '{"error":"Cannot execute localharness",[redacted:labeled-kv]}\nharness: Permission denied {[redacted:labeled-kv]}'
        }
      }
    })
  }
)

it('reserves space for long RPC details and the newest redacted stderr', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', (frame) => {
        rig.child().stderr = `${'old stderr\n'.repeat(100)}recent harness failure token=private`
        agent.fail(frame, -32603, 'Internal error', { details: `RPC evidence ${'x'.repeat(700)}` })
      })
  })
  await rig.acquire()
  const detail = rig.openVerdict()?.fact.detail?.text
  expect(detail).toHaveLength(512)
  expect(detail).toContain('RPC evidence')
  expect(detail).toContain('recent harness failure [redacted:labeled-kv]')
  expect(detail).not.toContain('private')
})

it('keeps existing sign-in failure wording free of preceding stderr', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', (frame) => {
        rig.child().stderr = 'unrelated preceding stderr'
        agent.fail(frame, -32000, 'Please sign in')
      })
  })
  await rig.acquire()
  expect(rig.openVerdict()?.fact.kind).toBe('notSignedIn')
  expect(rig.openVerdict()?.fact.detail?.text).not.toContain('preceding stderr')
})

it.each(['load', 'resume'] as const)(
  'retains a rejected %s in the trace and exported bundle after fallback succeeds',
  async (method) => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-start-diagnostic-'))
    const traceFile = join(directory, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath: traceFile })
    onTestFinished(async () => {
      setActiveSink(null)
      sink.close()
      await rm(directory, { recursive: true, force: true })
    })
    setActiveSink(sink)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rig = await openAcpAdapterRig({
      spec: { ...GROK, resumePreference: method === 'resume' ? 'resume' : undefined },
      initialize: {
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
      },
      launch: {
        resume: {
          sessionId: 'saved-session',
          key: 'acp:grok:saved',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      },
      deps: { logger: createStructuredAgentSessionLogger() },
      script: (agent) =>
        agent.on(`session/${method}`, (frame) => {
          rig.child().stderr =
            'saved database unavailable "authorization":"Bearer stderr-private" refresh_token="opaque-oauth-proof" harness evidence'
          agent.fail(
            frame,
            -32603,
            'Internal error',
            method === 'load'
              ? { reason: 'database open failed', token: 'rpc-private' }
              : { details: '{"error":"database open failed","token":"rpc-private"}' }
          )
        })
    })
    await rig.acquire()
    expect(rig.openVerdict()).toBeUndefined()
    expect(rig.started().link?.origin).toBe('created')
    await sink.flushAsync()
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 1,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).toContain('agentSession.acp-restore-failed')
    expect(bundle.payload).toContain('providerDetail')
    expect(bundle.payload).toContain('database open failed')
    expect(bundle.payload).toContain('saved database unavailable [redacted:labeled-kv]')
    expect(bundle.payload).not.toContain('rpc-private')
    expect(bundle.payload).not.toContain('stderr-private')
    expect(bundle.payload).toContain('harness evidence')
    expect(bundle.payload).not.toContain('opaque-oauth-proof')
  }
)
