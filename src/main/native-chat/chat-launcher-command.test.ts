import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'
import {
  createAcpStructuredLaunchResolver,
  createClaudeStructuredLaunchResolver,
  createCodexStructuredLaunchResolver,
  createPiRpcLaunchResolver
} from '../runtime/structured-agent-launch-composition.test-support'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { buildPiRpcLaunch } from '../pi/rpc-launch'

const agents = ['claude', 'codex', 'pi', 'grok'] as const

describe('chat launcher argv', () => {
  it.each(agents)(
    'keeps stock argv and puts an opaque prefix before %s chat arguments',
    async (agent) => {
      const record = agentSessionRecordFixture({
        sessionId: 'launcher-command-test',
        provider: agent,
        accountHome: {
          variable:
            agent === 'claude'
              ? 'CLAUDE_CONFIG_DIR'
              : agent === 'codex'
                ? 'CODEX_HOME'
                : agent === 'pi'
                  ? 'PI_CODING_AGENT_DIR'
                  : 'GROK_HOME',
          path: '/account'
        }
      })
      const settings = { agentCmdOverrides: { [agent]: '' } }
      const common = {
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        resolveWorkspacePath: async () => '/workspace',
        resolveEnvironment: async () => ({ HOME: '/home', PATH: '/bin' }),
        resolveCommandSettings: () => settings
      }
      const resolveCommand = (options?: { pathEnv?: string | null; homePath?: string }) =>
        resolveStructuredAgentCommand(agent, settings, options, { resolve: () => process.execPath })
      const readVersion = vi.fn(async () => ({ version: '99.0.0' }))
      const identity = {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent,
        providerHandle: null
      }
      const spec = acpLaunchSpecFor('grok')!
      const resolve =
        agent === 'claude'
          ? createClaudeStructuredLaunchResolver({
              ...common,
              resolveCommand,
              resolveLaunchArgs: () => [],
              resolveAuthPolicy: () => ({ account: 'system' })
            })
          : agent === 'codex'
            ? createCodexStructuredLaunchResolver({
                ...common,
                resolveCommand,
                resolveLaunchArgs: () => ['--model', 'selected']
              })
            : agent === 'pi'
              ? ({ identity: sessionIdentity }: { identity: typeof identity }) =>
                  createPiRpcLaunchResolver({
                    ...common,
                    resolveCommand: () => process.execPath,
                    probeVersion: readVersion
                  })(sessionIdentity)
              : createAcpStructuredLaunchResolver(spec, {
                  ...common,
                  readJournal: () => null,
                  resolveCommand: () => process.execPath,
                  probeVersion: readVersion
                })
      const launches: Awaited<ReturnType<typeof resolve>>[] = []
      for (const command of [
        '',
        `"${process.execPath}"`,
        `"${process.execPath}" --mode text --profile work`
      ]) {
        settings.agentCmdOverrides[agent] = command
        launches.push(await resolve({ identity }))
      }
      const argv = (launch: (typeof launches)[number]): readonly string[] => {
        if ('options' in launch) {
          return launch.prefixArgs ?? []
        }
        if ('args' in launch) {
          return launch.args
        }
        return buildPiRpcLaunch(launch).args
      }
      expect(argv(launches[1]!)).toEqual(argv(launches[0]!))
      expect(argv(launches[2]!)).toEqual([
        '--mode',
        'text',
        '--profile',
        'work',
        ...argv(launches[0]!)
      ])
      if (agent === 'codex') {
        expect(argv(launches[2]!)).toEqual([
          '--mode',
          'text',
          '--profile',
          'work',
          '--model',
          'selected',
          'app-server'
        ])
      }
      if (agent === 'pi') {
        expect(readVersion).toHaveBeenLastCalledWith(
          expect.objectContaining({ prefixArgs: ['--mode', 'text', '--profile', 'work'] })
        )
      }
    }
  )
})
