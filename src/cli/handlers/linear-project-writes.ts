import type { LinearProjectUpdateAddResult } from '../../shared/linear/project-agent-writes'
import type { CommandHandler } from '../dispatch'
import { formatLinearProjectUpdateAdd, printLinearProjectResult } from '../linear-project-format'
import { buildProjectUpdateAddRequest } from '../linear-project-request-builders'
import { rewriteUnsupportedLinearProjectHost } from '../linear-project-unsupported-host'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const LINEAR_PROJECT_WRITES_HANDLERS: Record<string, CommandHandler> = {
  'linear project update add': async ({ flags, client, cwd, json }) => {
    const request = await buildProjectUpdateAddRequest(flags, cwd)
    const response = await client
      .call<LinearProjectUpdateAddResult>('linear.agentProjectUpdateAdd', request, {
        timeoutMs: LINEAR_WRITE_TIMEOUT_MS
      })
      .catch((error: unknown) => {
        throw rewriteUnsupportedLinearProjectHost(error, 'linear project update add')
      })
    printLinearProjectResult(response, json, formatLinearProjectUpdateAdd)
  }
}
