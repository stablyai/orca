import { expect, it } from 'vitest'
import type { ZcodeCliInvocation } from './zcode-cli-invocation'
import { resolveZcodeChatProgram, zcodeAppServerArgs } from './zcode-structured-launch-resolution'

const desktop = {
  command: '/opt/ZCode/zcode',
  prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
  envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
  identity: 'desktop',
  source: 'desktop-bundle'
} satisfies ZcodeCliInvocation

it('hosts the Desktop bundle app-server with the desktop surface', () => {
  expect(zcodeAppServerArgs(desktop)).toEqual([
    '/opt/ZCode/resources/glm/zcode.cjs',
    'app-server',
    '--stdio',
    '--surface',
    'desktop'
  ])
})

it('does not add the desktop surface to a standalone CLI', () => {
  expect(
    zcodeAppServerArgs({
      command: '/usr/local/bin/zcode',
      prefixArgs: [],
      envOverlay: {},
      identity: 'standalone',
      source: 'standalone'
    })
  ).toEqual(['app-server', '--stdio'])
})

it('publishes the resolved chat program with its environment overlay', () => {
  expect(
    resolveZcodeChatProgram({ PATH: '/usr/bin' }, {}, { resolveInvocation: () => desktop })
  ).toEqual({
    command: '/opt/ZCode/zcode',
    env: {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
})
