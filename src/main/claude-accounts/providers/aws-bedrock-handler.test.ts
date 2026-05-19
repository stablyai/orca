import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAwsBedrockHandler } from './aws-bedrock-handler'

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
