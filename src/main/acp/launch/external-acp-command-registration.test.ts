import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { antigravityChatRoute } from '../../antigravity/antigravity-chat-route'
import { invokeAntigravityAcpLaunch } from './external-acp-launch-test-support'
import type { AcpLaunchSettings } from './acp-structured-launch-resolution'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('honors the existing Command only when a profile registers an external ACP launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-acp-command-'))
  roots.push(root)
  const spec = ANTIGRAVITY_LAUNCH_SPEC
  const accountHome = await spec.account.resolve({ launchEnv: {}, stateDirectory: root })
  const invoke = (commandSettings: AcpLaunchSettings) =>
    invokeAntigravityAcpLaunch(spec, accountHome, root, commandSettings)

  const stock = await invoke({})
  expect(stock.command).toBe(stock.spec.command)
  const registered = await invoke({
    agentCmdOverrides: { antigravity: `${process.execPath} external-gateway.mjs` }
  })
  expect(registered.command).toBe(process.execPath)
  expect(registered.prefixArgs).toEqual(['external-gateway.mjs'])
  expect(ANTIGRAVITY_LAUNCH_SPEC.hostBackend?.spec.ignoreAgentCommandSetting).toBe(true)
})

it('rejects an invalid external launcher before it can fall back to the stock command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-acp-invalid-'))
  roots.push(root)
  const spec = ANTIGRAVITY_LAUNCH_SPEC
  const accountHome = await spec.account.resolve({ launchEnv: {}, stateDirectory: root })

  await expect(
    invokeAntigravityAcpLaunch(spec, accountHome, root, {
      agentCmdOverrides: { antigravity: 'external-launcher --flag $(whoami)' }
    })
  ).rejects.toThrow(/not a runnable program/)
})

it('keeps an explicit external command off the signed-in host backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-acp-host-route-'))
  roots.push(root)
  await expect(
    antigravityChatRoute(
      {
        command: 'host-command-not-found',
        env: {},
        envToDelete: [],
        homePath: root,
        stateDirectory: root,
        settings: {
          antigravityGoogleSignIn: 'agy',
          agentCmdOverrides: { antigravity: 'external-launcher' }
        },
        startsProgram: false
      },
      ANTIGRAVITY_LAUNCH_SPEC
    )
  ).resolves.toEqual({ agy: false, installs: 'server' })
})
