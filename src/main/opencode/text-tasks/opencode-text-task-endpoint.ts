import { z } from 'zod'
import { getOpenCodeCliCapabilities } from '../../../shared/opencode-cli-version'
import { createOpenCodeTextTaskHttp } from './opencode-text-task-http'
import type { openCodeTextTaskEndpoint } from './opencode-text-task-input'

export async function readOpenCodeTextTaskServer(
  endpoint: NonNullable<ReturnType<typeof openCodeTextTaskEndpoint>>,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  const password =
    endpoint.password ??
    env[endpoint.version === 'v2' ? 'OPENCODE_PASSWORD' : 'OPENCODE_SERVER_PASSWORD']
  const http = createOpenCodeTextTaskHttp(
    endpoint.url,
    password,
    '',
    endpoint.version === 'v2' ? 'opencode' : (endpoint.username ?? env.OPENCODE_SERVER_USERNAME),
    endpoint.version
  )
  const info = z
    .looseObject({ version: z.string() })
    .parse(
      await http.request(
        'GET',
        endpoint.version === 'v2' ? '/api/info' : '/global/health',
        undefined,
        signal
      )
    )
  const capabilities = getOpenCodeCliCapabilities(info.version)
  if (capabilities.pluginApi !== endpoint.version) {
    throw new Error('OpenCode selected server has an incompatible protocol')
  }

  return capabilities
}
