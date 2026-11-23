import { describe, expect, it, vi } from 'vitest'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { HandlerContext } from '../dispatch/dispatch'
import { parseArgs } from '../arguments/args'
import { formatCliError } from '../output/cli-error'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, type RuntimeCallOptions } from '../runtime/connection/types'
import { MANAGED_SERVER_HANDLERS } from './managed-server'
import { callExpectingRestart } from './managed-server-request'

describe('orca environment update', () => {
  it('refuses plain force on a desktop that could end uncounted terminals', async () => {
    const status = { capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] }
    const call = async (method: string, _params?: unknown, options?: RuntimeCallOptions) => {
      if (method === 'status.get') {
        return { id: 'status', ok: true, result: status, _meta: { runtimeId: 'legacy' } }
      }
      options?.requestSelection?.paramsForStatus(status)
      throw new Error('An update reached the older desktop.')
    }
    const context: HandlerContext = {
      flags: new Map<string, string | boolean>([
        ['environment', 'build-box'],
        ['force', true]
      ]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update handler only uses call.
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    }
    await expect(MANAGED_SERVER_HANDLERS['environment update']!(context)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })

  it.each([
    ['runtime_unavailable', 'managed_server_outcome_unknown', '--weird', 'orca-ide'],
    [
      'runtime_timeout',
      'managed_server_in_progress',
      '-build "box" terminal_held_wsl_distro_stopped:Ubuntu',
      'orca-dev'
    ]
  ])('preserves the WSL status target after %s', async (failure, code, selector, launcher) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', 'Ubuntu')
    vi.stubEnv('ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER', launcher === 'orca-ide' ? '1' : undefined)
    vi.stubEnv('ORCA_CLI_COMMAND', launcher === 'orca-ide' ? 'orca' : undefined)
    const call = async (method: string, _params?: unknown, options?: RuntimeCallOptions) => {
      if (method === 'managedServer.status') {
        return { id: 'status', ok: true, result: { activeVersion: 'other-version' } }
      }
      options?.requestSelection?.onDispatch?.()
      throw new RuntimeClientError(failure, 'No reply.')
    }
    const context: HandlerContext = {
      flags: new Map(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request uses only call.
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    }
    try {
      const error: unknown = await callExpectingRestart(context, 'managedServer.update', {
        selector
      }).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code, data: { selector } })
      const message = formatCliError(error)
      const command = message.match(/`([^`]+)`/)?.[1]?.split(' ')
      expect(command).toEqual([launcher, 'environment', 'status', '--environment=SELECTOR'])
      const displayed: string = JSON.parse(message.split('\n').at(-1)!)
      const argv = command!.slice(1).map((arg) => arg.replace('SELECTOR', () => displayed))
      expect(parseArgs(argv).flags.get('environment')).toBe(selector)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
    }
  })
})
