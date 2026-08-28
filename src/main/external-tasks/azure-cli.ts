import { runProcess } from '../../shared/child-process/run-process'

export async function getAzureCliToken(): Promise<string> {
  const result = await runProcess({
    program: 'az',
    args: [
      'account',
      'get-access-token',
      '--resource',
      '499b84ac-1321-427f-aa17-267ca6975798',
      '--output',
      'json'
    ],
    timeoutMs: 12_000
  })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Azure CLI is not authenticated')
  }
  const value = JSON.parse(result.stdout) as { accessToken?: string; expiresOn?: string }
  if (!value.accessToken) {
    throw new Error('Azure CLI returned no Azure DevOps access token')
  }
  return value.accessToken
}
