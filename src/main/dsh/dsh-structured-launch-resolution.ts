import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsDshStructuredLocation } from './dsh-structured-location-support'
import type { DshStructuredLaunch } from './dsh-structured-session-adapter'

export function resolveDshHome(env: NodeJS.ProcessEnv): string {
  const home = env.DSH_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.dsh')
  if (!isAbsolute(home)) {
    throw new Error('DeepSeek Harness requires an absolute execution-host DSH_HOME')
  }
  return resolve(home)
}

export function supportsDshAcpVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z0-9.-]+)?$/.exec(value.trim())
  if (!match) {
    return false
  }
  const major = Number(match[1]),
    minor = Number(match[2]),
    patch = Number(match[3])
  return major === 0 && (minor > 2 || (minor === 2 && patch >= 1))
}

export function createDshStructuredLaunchResolver(deps: {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveCommand?: (env: NodeJS.ProcessEnv) => string
}) {
  return async (input: StructuredAgentSessionAcquireInput): Promise<DshStructuredLaunch> => {
    const record = deps.store.getRecord(input.identity.sessionId)
    if (!record || record.provider !== 'dsh-acp' || record.accountHome.variable !== 'DSH_HOME') {
      throw new Error('DeepSeek Harness launch has no matching pinned session record')
    }
    if (!supportsDshStructuredLocation(record.location)) {
      throw new Error('DeepSeek Harness ACP is unsupported on this execution host')
    }
    const environment = { ...(await deps.resolveEnvironment()), DSH_HOME: record.accountHome.path }
    const resolvedEnv = Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
    const command =
      deps.resolveCommand?.(resolvedEnv) ??
      resolveCliCommand('dsh', {
        pathEnv: resolvedEnv.PATH,
        homePath: resolvedEnv.HOME || resolvedEnv.USERPROFILE
      })
    const env = withCliRuntimeOnPath(command, resolvedEnv)
    const cwd = await deps.resolveWorkspacePath(record.location.workspaceId)
    if (!isAbsolute(cwd)) {
      throw new Error('DeepSeek Harness workspace must be an absolute host path')
    }
    const version = await runProcess({
      program: command,
      args: ['--version'],
      cwd,
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      killOnOutputLimit: true
    })
    if (
      version.code !== 0 ||
      version.timedOut ||
      version.outputTruncated ||
      !supportsDshAcpVersion(version.stdout)
    ) {
      throw new Error(
        'Install official @deepseek-ai/dsh 0.2.1-alpha.1 or a compatible 0.x release for ACP'
      )
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (head && head.handle.provider !== 'dsh-acp') {
      throw new Error('DeepSeek Harness resume handle belongs to another provider')
    }
    return {
      command,
      args: ['--profile', 'acp'],
      env,
      cwd,
      ...(head?.handle.provider === 'dsh-acp' ? { resumeSessionId: head.handle.sessionId } : {})
    }
  }
}
