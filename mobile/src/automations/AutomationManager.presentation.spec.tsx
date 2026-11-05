import { MOBILE_RPC_METHOD_ROUTES } from '../../../src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { OrcaHookTrustDrawer } from '../components/OrcaHookTrustDrawer'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY
} from '../../../src/shared/automation-runtime-capabilities'
import {
  automationSchema,
  type MobileAutomation,
  type MobileAutomationRow
} from './automation-reply-schema'
import type { AutomationTargets } from './automation-target-inventory'
import { AutomationManager } from './AutomationManager'
import { AutomationList } from './AutomationList'
import {
  AutomationChoice,
  AutomationMetadata,
  AutomationButton,
  AutomationField
} from './AutomationControls'
import { ConfirmModal } from '../components/ConfirmModal'
import type { RpcClient } from '../transport/rpc-client'

import {
  automationClient,
  automationRepo,
  automationTargets,
  savedAutomation,
  savedRun,
  deferred
} from './automation-test-fixtures'

export function registerAutomationPresentationTests({
  inventory,
  root,
  press,
  setTree,
  mount: mountManager
}: {
  inventory: { targets: ReturnType<typeof vi.fn>; agents: ReturnType<typeof vi.fn> }
  root: () => ReactTestInstance
  press: (label: string) => Promise<void>
  setTree: (tree: ReactTestRenderer) => void
  mount: (
    loseCreate?: boolean | 'legacy',
    confirmSetup?: boolean
  ) => Promise<Pick<ReturnType<typeof automationClient>, 'send'>>
}): void {
  it('resolves project setup and obtains trust before creating through Task, Schedule and Review', async () => {
    const port = await mountManager(false, true)
    await press('New automation')
    const field = (label: string) =>
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === label)!
    await act(async () => {
      field('Name').props.onChange('Daily review')
      field('Instructions').props.onChange('Review changes')
    })
    expect(root().findAll((node) => String(node.type) === 'Switch')).toHaveLength(0)
    await press('Continue')
    expect(
      root()
        .findAllByType(AutomationChoice)
        .some((node) => node.props.label === 'Cadence')
    ).toBe(true)
    await press('Continue')
    await press('Create automation')
    expect(port.send.mock.calls.filter(([method]) => method === 'automation.create')).toEqual([])
    const drawer = root().findByType(OrcaHookTrustDrawer)
    expect(drawer.props).toMatchObject({
      visible: true,
      prompt: { repoId: 'repo-1', contentHash: 'setup-hash', scriptContent: 'npm ci' }
    })
    expect(drawer.props.busy).toBe(false)
    await act(async () => {
      drawer.props.onRunOnce()
    })
    const attempts = port.send.mock.calls.filter(([method]) => method === 'automation.create')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.[1]).toMatchObject({
      enabled: true,
      name: 'Daily review',
      repo: 'id:repo-1',
      setupDecision: 'run',
      runContext: {
        hostId: 'local',
        repoId: 'repo-1',
        path: '/repo',
        projectHostSetupId: 'setup-1'
      },
      destination: { selector: { kind: 'self' } },
      creationKey: expect.any(String)
    })
    expect(port.send.mock.calls.find(([method]) => method === 'repo.hooks')?.[1]).toEqual({
      repo: 'id:repo-1'
    })
    expect(port.send.mock.calls.findIndex(([method]) => method === 'ui.set')).toBeLessThan(
      port.send.mock.calls.findIndex(([method]) => method === 'automation.create')
    )
    expect(root().findAll((node) => String(node.type) === 'Switch')).toHaveLength(1)
    await press('All automations')
    expect(
      root()
        .findAllByType(AutomationButton)
        .some((node) => node.props.label === 'New automation')
    ).toBe(true)
  })

  it('confirms a server script without reading or granting the paired desktop trust', async () => {
    const executionHost = 'runtime:server' as const
    const targets = automationTargets()
    const setup = { ...targets.setups[0]!, path: '/server/repo' }
    inventory.targets.mockResolvedValue({ ...targets, setups: [setup] })
    const desktop = {
      repo: automationRepo(),
      ui: { trustedOrcaHooks: { [setup.repoId]: { all: { approvedAt: 1 } } } }
    }
    const desktopBefore = JSON.stringify(desktop)
    const desktopRequests: string[] = []
    const port = automationClient(() => ({}))
    let created: MobileAutomation | null = null
    const send = vi.fn<RpcClient['sendRequest']>(async (method, params, options) => {
      let result: unknown
      if (MOBILE_RPC_METHOD_ROUTES.get(method) === 'paired-desktop') {
        desktopRequests.push(method)
        if (method === 'ui.get') {
          result = { ui: desktop.ui }
        } else if (method === 'ui.set') {
          Object.assign(desktop.ui, params)
          result = { ui: desktop.ui }
        } else {
          throw new Error(`Unexpected desktop request: ${method}`)
        }
      } else {
        expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
        expect(options?.envelope?.executionHost).toBe(executionHost)
        if (method === 'status.get') {
          result = { capabilities: [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        } else if (method === 'automation.list') {
          result = {
            automations: created ? [created] : [],
            items: created ? [{ automationId: created.id, selector: { kind: 'self' } }] : []
          }
        } else if (method === 'repo.list') {
          result = { repos: [automationRepo(setup)] }
        } else if (method === 'repo.hooks') {
          result = {
            source: 'orca.yaml',
            setupRunPolicy: 'run-by-default',
            setupConfig: { command: 'server script B' },
            setupTrust: { contentHash: 'server-hash-B', scriptContent: 'server script B' }
          }
        } else if (method === 'automation.create') {
          created = automationSchema.parse({
            ...savedAutomation(),
            ...(params && typeof params === 'object' ? params : {}),
            id: 'server-created',
            workspaceId: null
          })
          result = { automation: created }
        } else if (method === 'automation.runs') {
          result = { runs: [] }
        } else {
          throw new Error(`Unexpected server request: ${method}`)
        }
      }
      return { id: 'reply', ok: true, result }
    })
    const client = scopeRpcClientToExecutionHost(
      { ...port.client, sendRequest: send },
      executionHost
    )
    await act(async () => {
      setTree(
        create(createElement(AutomationManager, { client, hostId: 'desktop', executionHost }))
      )
    })
    await press('New automation')
    await act(async () => {
      for (const [label, value] of [
        ['Name', 'Server review'],
        ['Instructions', 'Review on server']
      ]) {
        root()
          .findAllByType(AutomationField)
          .find((node) => node.props.label === label)!
          .props.onChange(value)
      }
    })
    await press('Continue')
    await press('Continue')
    await press('Create automation')
    expect(send.mock.calls.filter(([method]) => method === 'automation.create')).toEqual([])
    const drawer = root().findByType(OrcaHookTrustDrawer)
    expect(drawer.props).toMatchObject({
      visible: true,
      allowAlwaysTrust: false,
      prompt: {
        repoId: setup.repoId,
        contentHash: 'server-hash-B',
        scriptContent: 'server script B'
      }
    })
    expect(
      root().findAll(
        (node) => String(node.type) === 'Text' && node.props.children === 'Always trust and run'
      )
    ).toHaveLength(0)
    expect(desktopRequests).toEqual([])
    await act(async () => {
      drawer.props.onRunOnce()
    })
    const creates = send.mock.calls.filter(([method]) => method === 'automation.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]?.[1]).toMatchObject({
      repo: `id:${setup.repoId}`,
      setupDecision: 'run',
      creationKey: expect.any(String),
      runContext: {
        hostId: 'local',
        repoId: setup.repoId,
        path: setup.path,
        projectHostSetupId: setup.id
      },
      destination: { selector: { kind: 'self' } }
    })
    expect(creates[0]?.[2]).toMatchObject({
      failWhenDisconnected: true,
      envelope: { executionHost }
    })
    expect(desktopRequests).toEqual([])
    expect(JSON.stringify(desktop)).toBe(desktopBefore)
  })

  const metadata = (label: string) =>
    root()
      .findAllByType(AutomationMetadata)
      .find((node) => node.props.label === label)?.props.value
  const input = (label: string) =>
    root().findAll(
      (node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label
    )[0]!
  async function open() {
    await act(async () => {
      const list = root().findByType(AutomationList)
      list.props.onOpen(list.props.rows[0])
    })
  }
  function portFor(
    initial = savedAutomation(),
    selector: MobileAutomationRow['item']['selector'] = { kind: 'self' }
  ) {
    let current: MobileAutomation = initial
    return automationClient((method, params) => {
      if (method === 'status.get') {
        return { capabilities: [AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY] }
      }
      if (method === 'automation.list') {
        return { automations: [current], items: [{ automationId: current.id, selector }] }
      }
      if (method === 'automation.runs') {
        return { runs: [savedRun()] }
      }
      if (method === 'automation.show') {
        return { automation: current }
      }
      if (method === 'automation.update') {
        if (
          params &&
          typeof params === 'object' &&
          'updates' in params &&
          params.updates &&
          typeof params.updates === 'object'
        ) {
          current = { ...current, ...params.updates }
        }
        return { automation: current }
      }
      if (method === 'automation.runNow') {
        return { run: savedRun('returned-manual') }
      }
      if (method === 'automation.delete') {
        return { removed: true, id: current.id }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
  }
  async function mount(port: ReturnType<typeof automationClient>) {
    let tree: ReactTestRenderer
    await act(async () => {
      tree = create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' }))
      setTree(tree)
    })
    await open()
  }

  it('keeps captured-owner actions independent of delayed and failed label acquisition', async () => {
    const pending = deferred<AutomationTargets>()
    inventory.targets
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValue(new Error('inventory unavailable'))
    const port = portFor(savedAutomation(), {
      kind: 'ssh',
      targetId: 'builder',
      targetGeneration: 7
    })
    await mount(port)
    expect(metadata('Workspace')).toBe('Unavailable')
    await act(async () =>
      root()
        .findAll((node) => String(node.type) === 'Switch')[0]!
        .props.onValueChange(true)
    )
    expect(inventory.targets).toHaveBeenCalledTimes(1)
    expect(port.send).toHaveBeenCalledWith(
      'automation.update',
      {
        id: 'automation-1',
        updates: { enabled: true },
        expectedOwner: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
      },
      { failWhenDisconnected: true }
    )
    await act(async () => pending.reject(new Error('late inventory failure')))
    await press('Run now')
    expect(port.send).toHaveBeenCalledWith(
      'automation.runNow',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
      },
      { failWhenDisconnected: true }
    )
    await press('All runs')
    // Return through the same list surface; inventory errors must not turn labels into action gates.
    const segments = root().findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.segments
    )[0]!
    await act(async () => segments.props.onSelect('automations'))
    await open()
    await press('Edit')
    expect(port.send).toHaveBeenCalledWith(
      'automation.show',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
      },
      { failWhenDisconnected: true }
    )
    await press('Cancel')
    await press('Delete automation')
    await act(async () => root().findByType(ConfirmModal).props.onConfirm())
    expect(port.send).toHaveBeenCalledWith(
      'automation.delete',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
      },
      { failWhenDisconnected: true }
    )
  })

  it('lists, shows and renames an automation whose agent this build does not know without rewriting its agent', async () => {
    const port = portFor({ ...savedAutomation(), agentId: 'future-agent' })
    await act(async () => {
      setTree(create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' })))
    })
    expect(
      root()
        .findByType(AutomationList)
        .props.rows.map((row: MobileAutomationRow) => row.automation.agentId)
    ).toEqual(['future-agent'])
    await open()
    expect(metadata('Agent')).toBe('future-agent')
    await press('Edit')
    expect(
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Agent')!.props.options
    ).toContainEqual({ value: 'future-agent', label: 'future-agent (saved)' })
    await act(async () => input('Name').props.onChangeText('Renamed'))
    await press('Continue')
    await press('Continue')
    await press('Save changes')
    expect(port.send).toHaveBeenCalledWith(
      'automation.update',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'self' } },
        updates: { name: 'Renamed' }
      },
      { failWhenDisconnected: true }
    )
  })
}
