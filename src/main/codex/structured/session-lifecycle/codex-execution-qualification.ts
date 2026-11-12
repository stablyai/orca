import { createHash } from 'node:crypto'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { resolveCodexStructuredInvocation } from '../launch/codex-structured-launch-resolution'
import { readCodexExecutionExecutable } from '../launch/codex-execution-executable'
import type { CodexProviderInvocationDeps } from './codex-provider-session-rename'
import { codexProviderProbeCwd } from './codex-provider-session-rename'
import type { AgentSessionExecutionQualification } from '../../../../shared/agent-session/agent-session-execution-qualification'

export function readCodexExecutionQualification(
  readInvocation: () => CodexProviderInvocationDeps | undefined
): NonNullable<StructuredAgentSessionAdapter['readExecutionQualification']> {
  return async (record) => {
    const invocation = readInvocation()
    if (!invocation || !record.executionPolicy) {
      return null
    }
    const cwd = await codexProviderProbeCwd(record, invocation)
    const resolved = await resolveCodexStructuredInvocation({
      ...invocation,
      resolveWorkingDirectory: () => cwd
    })
    const executable = await readCodexExecutionExecutable(
      resolved.command,
      resolved.prefixArgs,
      cwd,
      resolved.environment
    )
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
    const env = Object.fromEntries(
      Object.entries(resolved.environment ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    const metadata = await runCodexAppServerSession(
      {
        command: executable.path,
        cliPath: executable.path,
        cwd,
        args: [
          '-c',
          'forced_login_method="chatgpt"',
          '-c',
          'model_provider="openai"',
          '-c',
          'openai_base_url="https://chatgpt.com/backend-api/codex"',
          '-c',
          'features.hooks=false',
          '-c',
          'features.codex_hooks=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          'app-server'
        ],
        env: { ...env, CODEX_HOME: accountHome },
        envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL'],
        timeoutMs: 20_000,
        treeKillOnFinish: true
      },
      async (rpc) => {
        const account = readRecord(
          readRecord(await rpc.request('account/read', { refreshToken: false })).account
        )
        const identity = account.id || account.email
        if (
          account.type !== 'chatgpt' ||
          typeof identity !== 'string' ||
          !identity.trim() ||
          !['pro', 'promax', 'plus', 'team', 'business', 'enterprise', 'edu'].includes(
            String(account.planType)
          )
        ) {
          throw new Error('Included Codex identity unavailable.')
        }
        const limits = readRecord(
          readRecord(await rpc.request('account/rateLimits/read', {})).rateLimits
        )
        const windows: NonNullable<AgentSessionExecutionQualification['metadata']>['limits'] = []
        for (const bucket of ['primary', 'secondary']) {
          const window = readRecord(limits[bucket])
          if (
            typeof window.usedPercent === 'number' &&
            Number.isFinite(window.usedPercent) &&
            window.usedPercent >= 0 &&
            window.usedPercent <= 100 &&
            typeof window.resetsAt === 'number' &&
            Number.isSafeInteger(window.resetsAt) &&
            window.resetsAt > 0
          ) {
            windows.push({
              bucket,
              remaining: 1 - window.usedPercent / 100,
              resetAt: window.resetsAt
            })
          }
        }
        if (!windows.length) {
          throw new Error('Included Codex allowance unavailable.')
        }
        const catalog: NonNullable<AgentSessionExecutionQualification['metadata']>['catalog'] = []
        const seen = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = readRecord(
            await rpc.request('model/list', {
              includeHidden: true,
              limit: 100,
              ...(cursor ? { cursor } : {})
            })
          )
          if (!Array.isArray(result.data)) {
            throw new Error('Codex catalog unavailable.')
          }
          for (const item of result.data) {
            const model = readRecord(item)
            const efforts = Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((entry) => readRecord(entry).reasoningEffort)
              : []
            if (
              typeof model.model !== 'string' ||
              !model.model ||
              seen.has(model.model) ||
              !efforts.length ||
              !efforts.every(
                (effort): effort is string => typeof effort === 'string' && effort.length > 0
              )
            ) {
              throw new Error('Codex catalog invalid.')
            }
            seen.add(model.model)
            catalog.push({ model: model.model, efforts })
          }
          if (result.nextCursor === null || result.nextCursor === undefined) {
            break
          }
          if (
            typeof result.nextCursor !== 'string' ||
            !result.nextCursor ||
            result.nextCursor === cursor ||
            page === 19
          ) {
            throw new Error('Codex catalog incomplete.')
          }
          cursor = result.nextCursor
        }
        return {
          executable,
          observedAt: Date.now(),
          account: {
            fingerprint: `codex:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}`,
            plan: String(account.planType)
          },
          limits: windows,
          catalog
        }
      }
    )
    const after = await readCodexExecutionExecutable(
      resolved.command,
      resolved.prefixArgs,
      cwd,
      resolved.environment
    )
    if (JSON.stringify(after) !== JSON.stringify(executable)) {
      return null
    }
    return metadata
  }
}
