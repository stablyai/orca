import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cursorModelsFromAvailableList } from '../../cursor/cursor-acp-model-catalog'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { resolveAcpLaunchInvocation } from '../launch/acp-structured-launch-resolution'
import { openAcpAdapterRig, PROVIDER_SESSION } from './testing/acp-structured-adapter.test-support'

const CURSOR = acpLaunchSpecFor('cursor')!
afterEach(closeProviderTimelineRigs)

it('launches cursor-agent acp and signs in with the existing Cursor login', async () => {
  const rig = await openAcpAdapterRig({
    spec: CURSOR,
    initialize: { authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.frames.some((sent) => sent.method === 'authenticate')
          ? agent.reply(frame, { sessionId: PROVIDER_SESSION })
          : agent.fail(frame, -32000, 'Authentication required')
      )
      agent.on('authenticate', (frame) => agent.reply(frame, {}))
    }
  })
  await rig.acquire()
  expect(rig.sent('authenticate')[0]?.params).toEqual({ methodId: 'cursor_login' })
  expect(CURSOR.loginCommand).toEqual(['cursor-agent', 'login'])
})

it('sets Cursor effort and fast as their own options, and lists base models before a chat exists', () => {
  const options = new AcpStructuredOptions(CURSOR.dialect)
  options.adoptSession(
    {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'grok-4.7',
          options: [
            { value: 'default', name: 'Auto' },
            { value: 'grok-4.7', name: 'Grok 4.7' }
          ]
        },
        {
          id: 'reasoning_effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' }
          ]
        },
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'true',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' }
          ]
        }
      ]
    },
    'new'
  )
  expect(options.read().models.map((model) => [model.id, model.label])).toEqual([
    ['default', 'Auto'],
    ['grok-4.7', 'Grok 4.7']
  ])
  expect(options.read().current).toMatchObject({
    model: 'grok-4.7',
    effort: 'medium',
    fastMode: true
  })
  expect(options.write('effort', 'low')).toEqual({
    method: 'config',
    configId: 'reasoning_effort',
    value: 'low'
  })
  expect(options.write('fastMode', 'false')).toEqual({
    method: 'config',
    configId: 'fast',
    value: 'false'
  })
  expect(CURSOR.dialect.clientCapabilities).toEqual({
    _meta: { parameterizedModelPicker: true }
  })
  expect(CURSOR.modelDiscovery.kind).toBe('initialize')
  expect(
    cursorModelsFromAvailableList({
      models: [
        { value: 'default', name: 'Auto', configOptions: [] },
        {
          value: 'composer-2.5',
          name: 'Composer 2.5',
          configOptions: [
            {
              id: 'fast',
              category: 'model_config',
              options: [
                { value: 'false', name: 'Off' },
                { value: 'true', name: 'Fast' }
              ]
            }
          ]
        },
        {
          value: 'grok-4.7',
          name: 'Grok 4.7',
          configOptions: [
            {
              id: 'reasoning_effort',
              name: 'Effort',
              category: 'thought_level',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' }
              ]
            }
          ]
        }
      ]
    })
  ).toEqual([
    { id: 'default', label: 'Auto', isDefault: false, efforts: [], declaredDefaultEffort: null },
    {
      id: 'composer-2.5',
      label: 'Composer 2.5',
      isDefault: false,
      efforts: [],
      declaredDefaultEffort: null,
      supportsFastMode: true
    },
    {
      id: 'grok-4.7',
      label: 'Grok 4.7',
      isDefault: false,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    }
  ])
})

it('grants full access with --yolo and keeps the host Cursor login out of the child environment', async () => {
  expect(CURSOR.args({ fullAccess: false, pluginDir: null })).toEqual([
    '--disable-auto-update',
    'acp'
  ])
  expect(CURSOR.args({ fullAccess: true, pluginDir: null })).toEqual([
    '--disable-auto-update',
    '--yolo',
    'acp'
  ])
  const home = await CURSOR.account.resolve({
    launchEnv: { HOME: '/Users/ada' },
    stateDirectory: '/state'
  })
  expect(home).toEqual({
    variable: 'ORCA_CURSOR_CONFIG_DIR',
    path: join('/Users/ada', '.cursor')
  })
  const launch = await resolveAcpLaunchInvocation(CURSOR, home, {
    dataDirectory: '/isolated',
    inheritedEnv: { ORCA_CURSOR_CONFIG_DIR: join('/Users/ada', '.cursor') },
    resolveEnvironment: async () => ({
      HOME: '/Users/ada',
      PATH: '/bin',
      ORCA_CURSOR_CONFIG_DIR: join('/Users/ada', '.cursor')
    }),
    resolveCommand: () => '/bin/cursor-agent'
  })
  expect(launch.env).toEqual({ HOME: '/Users/ada', PATH: '/bin' })
  expect(launch.envToDelete).toEqual(['ORCA_CURSOR_CONFIG_DIR'])
  expect(() => CURSOR.account.environment({ variable: 'GROK_HOME', path: '/x' }, {})).toThrow(
    "this chat uses the host's Cursor login"
  )
})
