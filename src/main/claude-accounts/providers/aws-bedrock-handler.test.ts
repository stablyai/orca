import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAwsBedrockHandler } from './aws-bedrock-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

const writeKeychainMock = vi.fn(async (_id: string, _value: string): Promise<void> => {})
const readKeychainMock = vi.fn(async (_id: string): Promise<string | null> => 'bedrock-bearer-token')

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: (id: string, value: string) =>
    writeKeychainMock(id, value),
  readManagedClaudeKeychainCredentials: (id: string) => readKeychainMock(id)
}))

describe('awsBedrockHandler.registerAccount — static token', () => {
  beforeEach(() => {
    writeKeychainMock.mockClear()
    readKeychainMock.mockClear()
  })

  it('stores AWS_BEARER_TOKEN_BEDROCK in keychain', async () => {
    const handler = createAwsBedrockHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Bedrock US',
      secretFromUser: 'bedrock-bearer-token',
      providerConfig: { region: 'us-east-1' } as never
    })

    expect(writeKeychainMock).toHaveBeenCalledWith('a1', 'bedrock-bearer-token')
    expect(result.credentials).toEqual({
      authMethod: 'aws-bedrock',
      region: 'us-east-1',
      inferenceProfilePrefix: 'us.'
    })
    expect(result.email).toBe('Bedrock US')
  })

  it('IAM-chain path: empty secret is allowed, no keychain write', async () => {
    const handler = createAwsBedrockHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Bedrock IAM',
      secretFromUser: '',
      providerConfig: { region: 'eu-west-1' } as never
    })

    expect(writeKeychainMock).not.toHaveBeenCalled()
    expect(result.credentials).toEqual({
      authMethod: 'aws-bedrock',
      region: 'eu-west-1',
      inferenceProfilePrefix: 'eu.'
    })
  })

  it('rejects missing region', async () => {
    const handler = createAwsBedrockHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'x',
        secretFromUser: 'token',
        providerConfig: {} as never
      })
    ).rejects.toThrow(/region/i)
  })
})

function bedrockAccount(region: string, prefix?: string): ClaudeManagedAccount {
  return {
    id: 'a1',
    email: 'Bedrock',
    managedAuthPath: '/tmp/a1/auth',
    authMethod: 'aws-bedrock',
    credentials: {
      authMethod: 'aws-bedrock',
      region,
      inferenceProfilePrefix: prefix ?? ''
    },
    modelMapping: {},
    fallbackAccountIds: [],
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

describe('awsBedrockHandler.materialize', () => {
  beforeEach(() => {
    writeKeychainMock.mockClear()
    readKeychainMock.mockReset()
  })

  it('static-token path: emits AWS_BEARER_TOKEN_BEDROCK + region + USE_BEDROCK + prefixed model defaults', async () => {
    readKeychainMock.mockResolvedValueOnce('bearer-xyz')
    const handler = createAwsBedrockHandler()
    const out = await handler.materialize(bedrockAccount('us-east-1', 'us.'))

    expect(out.envPatch.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(out.envPatch.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-xyz')
    expect(out.envPatch.AWS_REGION).toBe('us-east-1')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('us.anthropic.claude-opus-4-7')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('us.anthropic.claude-sonnet-4-6')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    )
  })

  it('IAM-chain path: no keychain entry → omits AWS_BEARER_TOKEN_BEDROCK, keeps region + USE_BEDROCK', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    const handler = createAwsBedrockHandler()
    const out = await handler.materialize(bedrockAccount('eu-west-1', 'eu.'))

    expect(out.envPatch.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(out.envPatch.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(out.envPatch.AWS_REGION).toBe('eu-west-1')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('eu.anthropic.claude-opus-4-7')
  })

  it('unknown region with no prefix → raw model id without prefix', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    const handler = createAwsBedrockHandler()
    const out = await handler.materialize(bedrockAccount('ca-central-1', ''))
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic.claude-opus-4-7')
  })

  it('per-account modelMapping overrides defaults but keeps prefix applied', async () => {
    readKeychainMock.mockResolvedValueOnce('t')
    const handler = createAwsBedrockHandler()
    const acct = bedrockAccount('us-east-1', 'us.')
    acct.modelMapping = { opus: 'anthropic.claude-opus-4-7-experimental' }
    const out = await handler.materialize(acct)
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      'us.anthropic.claude-opus-4-7-experimental'
    )
  })
})

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void
const execFileMock = vi.fn<
  (cmd: string, args: string[], cb: ExecFileCb) => void
>()

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], cb: ExecFileCb) => execFileMock(cmd, args, cb)
}))

describe('awsBedrockHandler.validate', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    readKeychainMock.mockReset()
  })

  it('static-token path: probes Bedrock list-foundation-models with bearer present', async () => {
    readKeychainMock.mockResolvedValueOnce('bearer-xyz')
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '{"modelSummaries":[]}', ''))
    const handler = createAwsBedrockHandler()
    const r = await handler.validate(bedrockAccount('us-east-1', 'us.'))
    expect(r.ok).toBe(true)
  })

  it('IAM-chain path: shells out to `aws sts get-caller-identity`', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    execFileMock.mockImplementation((_cmd, _args, cb) =>
      cb(null, '{"Arn":"arn:aws:iam::1:user/x"}', '')
    )
    const handler = createAwsBedrockHandler()
    const r = await handler.validate(bedrockAccount('us-east-1', 'us.'))
    expect(execFileMock).toHaveBeenCalledWith(
      'aws',
      expect.arrayContaining(['sts', 'get-caller-identity']),
      expect.any(Function)
    )
    expect(r.ok).toBe(true)
  })

  it('IAM-chain failure → locked credentials-missing message', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 255') as Error & { stderr?: string }
      err.stderr = 'Unable to locate credentials'
      cb(err, '', 'Unable to locate credentials')
    })
    const handler = createAwsBedrockHandler()
    const r = await handler.validate(bedrockAccount('us-east-1', 'us.'))
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toBe(
      'AWS credentials missing/expired. Run `aws sso login` then click Detect.'
    )
  })

  it('Bedrock access denied → locked 403 message', async () => {
    readKeychainMock.mockResolvedValueOnce('t')
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 254') as Error & { stderr?: string }
      err.stderr = 'AccessDeniedException: not authorized'
      cb(err, '', 'AccessDeniedException: not authorized')
    })
    const handler = createAwsBedrockHandler()
    const r = await handler.validate(bedrockAccount('us-east-1', 'us.'))
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toBe('Bedrock model access denied. Request in AWS console.')
  })

  it('unknown AWS CLI error → locked network message', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    execFileMock.mockImplementation((_c, _a, cb) => {
      const err = new Error('exit 1') as Error & { stderr?: string }
      err.stderr = 'Connection timed out'
      cb(err, '', 'Connection timed out')
    })
    const handler = createAwsBedrockHandler()
    const r = await handler.validate(bedrockAccount('us-east-1', 'us.'))
    if (r.ok) throw new Error('expected fail')
    expect(r.reason).toBe('Network or AWS error contacting Bedrock.')
  })
})
