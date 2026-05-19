import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGoogleVertexHandler } from './google-vertex-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(async () => null),
  removeManagedClaudeKeychainCredentials: vi.fn()
}))

function vertexAccount(): ClaudeManagedAccount {
  return {
    id: 'a1',
    email: 'Vertex',
    managedAuthPath: '/tmp/a1/auth',
    authMethod: 'google-vertex',
    credentials: {
      authMethod: 'google-vertex',
      projectId: 'my-gcp',
      region: 'us-east5'
    },
    modelMapping: {},
    fallbackAccountIds: [],
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

describe('googleVertexHandler.registerAccount', () => {
  it('records projectId + region, never writes keychain (ADC-only)', async () => {
    const handler = createGoogleVertexHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Vertex',
      secretFromUser: '',
      providerConfig: { projectId: 'my-gcp-project', region: 'us-east5' } as never
    })

    expect(result.credentials).toEqual({
      authMethod: 'google-vertex',
      projectId: 'my-gcp-project',
      region: 'us-east5'
    })
  })

  it('rejects missing projectId', async () => {
    const handler = createGoogleVertexHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'x',
        secretFromUser: '',
        providerConfig: { region: 'us-east5' } as never
      })
    ).rejects.toThrow(/project/i)
  })

  it('rejects missing region', async () => {
    const handler = createGoogleVertexHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'x',
        secretFromUser: '',
        providerConfig: { projectId: 'p' } as never
      })
    ).rejects.toThrow(/region/i)
  })
})

describe('googleVertexHandler.materialize', () => {
  it('emits USE_VERTEX, projectId, region, default models', async () => {
    const handler = createGoogleVertexHandler()
    const out = await handler.materialize(vertexAccount())

    expect(out.envPatch.CLAUDE_CODE_USE_VERTEX).toBe('1')
    expect(out.envPatch.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-gcp')
    expect(out.envPatch.CLOUD_ML_REGION).toBe('us-east5')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5@20251001')
  })

  it('"global" region passes through to CLOUD_ML_REGION', async () => {
    const handler = createGoogleVertexHandler()
    const acct = vertexAccount()
    if (acct.credentials.authMethod !== 'google-vertex') throw new Error('bad fixture')
    acct.credentials.region = 'global'
    const out = await handler.materialize(acct)
    expect(out.envPatch.CLOUD_ML_REGION).toBe('global')
  })

  it('per-account modelMapping overrides defaults', async () => {
    const handler = createGoogleVertexHandler()
    const acct = vertexAccount()
    acct.modelMapping = { opus: 'claude-opus-4-7-preview' }
    const out = await handler.materialize(acct)
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7-preview')
  })

  it('never emits a token env var (ADC-only)', async () => {
    const handler = createGoogleVertexHandler()
    const out = await handler.materialize(vertexAccount())
    expect(out.envPatch.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(out.envPatch.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
  })
})

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void
const execFileMock = vi.fn<(cmd: string, args: string[], cb: ExecFileCb) => void>()

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], cb: ExecFileCb) => execFileMock(cmd, args, cb)
}))

describe('googleVertexHandler.validate', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('happy path: gcloud print-access-token succeeds', async () => {
    execFileMock.mockImplementation((_c, _a, cb) => cb(null, 'ya29.abc...\n', ''))
    const handler = createGoogleVertexHandler()
    const r = await handler.validate(vertexAccount())
    expect(execFileMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining(['auth', 'application-default', 'print-access-token']),
      expect.any(Function)
    )
    expect(r.ok).toBe(true)
  })

  it('no ADC → locked message about gcloud login', async () => {
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 1') as Error & { stderr?: string }
      err.stderr =
        'Reauthentication required. Please run gcloud auth application-default login.'
      cb(err, '', err.stderr)
    })
    const handler = createGoogleVertexHandler()
    const r = await handler.validate(vertexAccount())
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toMatch(/No GCP credentials\. Run `gcloud auth application-default login`\./)
  })

  it('project lacks Vertex/Claude → locked enablement message', async () => {
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 7') as Error & { stderr?: string }
      err.stderr =
        'API [aiplatform.googleapis.com] has not been used or is disabled in project my-gcp'
      cb(err, '', err.stderr)
    })
    const handler = createGoogleVertexHandler()
    const r = await handler.validate(vertexAccount())
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toMatch(/Project does not have Vertex AI \/ Claude enabled\./)
  })

  it('unknown gcloud error → locked network message', async () => {
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 1') as Error & { stderr?: string }
      err.stderr = 'Connection refused'
      cb(err, '', err.stderr)
    })
    const handler = createGoogleVertexHandler()
    const r = await handler.validate(vertexAccount())
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toMatch(/Network or gcloud error contacting Vertex AI\./)
  })
})
