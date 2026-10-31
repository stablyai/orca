import { AUTOMATION_ORPHAN_ISSUES } from '../../../src/shared/automation-list-scope'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { MOBILE_RPC_METHOD_ROUTES } from '../../../src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-routing'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { SetupHookTrustDrawer } from '../components/SetupHookTrustDrawer'
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
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
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
    const drawer = root().findByType(SetupHookTrustDrawer)
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
    const drawer = root().findByType(SetupHookTrustDrawer)
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
  it('localizes known orphan reasons in French list and detail while preserving unknown host text', async () => {
    await activateMobileUiLocale('fr')
    try {
      for (const [issue, expected] of [
        [
          AUTOMATION_ORPHAN_ISSUES.projectMissing,
          'Son projet n’existe plus, il est donc impossible de déterminer son hôte.'
        ],
        ['Future host reason', 'Future host reason']
      ]) {
        const port = portFor(savedAutomation(), { kind: 'orphan', issue })
        let unmount = () => {}
        await act(async () => {
          const tree = create(
            createElement(AutomationManager, { client: port.client, hostId: 'desktop' })
          )
          setTree(tree)
          unmount = () => tree.unmount()
        })
        const text = () =>
          root()
            .findAll((node) => String(node.type) === 'Text')
            .map((node) => node.props.children)
        expect(text()).toContain(expected)
        expect(text()).not.toContain(AUTOMATION_ORPHAN_ISSUES.projectMissing)
        await open()
        expect(text()).toContain(expected)
        expect(text()).not.toContain(AUTOMATION_ORPHAN_ISSUES.projectMissing)
        const button = (label: string) =>
          root()
            .findAllByType(AutomationButton)
            .find((node) => node.props.label === label)!
        expect(button('Exécuter maintenant').props.disabled).toBe(true)
        expect(button('Édition').props.disabled).toBe(false)
        expect(button("Supprimer l'automatisation").props.disabled).toBe(false)
        expect(port.send.mock.calls.some(([method]) => method === 'automation.runNow')).toBe(false)
        await act(async () => unmount())
      }
    } finally {
      await act(async () => {
        await activateMobileUiLocale('en')
      })
    }
  })

  function twins(reverse = false) {
    const targets = automationTargets()
    const local = { ...targets.setups[0]!, label: 'Review/desktop' }
    const ssh = { ...local, hostId: 'ssh:builder' as const, label: 'Review/builder' }
    targets.setups = reverse ? [ssh, local] : [local, ssh]
    targets.workspaces = targets.setups.map((setup) => ({
      worktreeId: 'repo-1::/repo',
      repoId: setup.repoId,
      hostId: setup.hostId,
      path: '/repo',
      displayName: `${setup.label} workspace`
    }))
    targets.coverage = {
      ...targets.coverage,
      totalCount: 2,
      hostScope: { hostIds: ['local', 'ssh:builder'], omittedHostIds: [] }
    }
    targets.sshTargets = [{ id: 'builder', label: 'Builder', generation: 7 }]
    return targets
  }

  it.each([
    ['local', false],
    ['local', true],
    ['ssh:builder', false],
    ['ssh:builder', true]
  ] as const)(
    'labels %s from canonical inventory with copied IDs and paths (reverse=%s)',
    async (hostId, reverse) => {
      const targets = twins(reverse)
      inventory.targets.mockResolvedValue(targets)
      const setup = targets.setups.find((entry) => entry.hostId === hostId)!
      const selector =
        hostId === 'local'
          ? { kind: 'self' as const }
          : { kind: 'ssh' as const, targetId: 'builder', targetGeneration: 7 }
      await mount(
        portFor(
          {
            ...savedAutomation(),
            workspaceId: 'repo-1::/repo',
            runContext:
              hostId === 'local'
                ? null
                : {
                    kind: 'workspace-run',
                    projectId: setup.projectId,
                    projectHostSetupId: setup.id,
                    hostId,
                    repoId: setup.repoId,
                    path: setup.path
                  }
          },
          selector
        )
      )
      expect(inventory.targets).toHaveBeenCalledTimes(1)
      expect(metadata('Project')).toBe(`${setup.label} · /repo`)
      expect(metadata('Workspace')).toBe(`${setup.label} workspace`)
      expect(metadata('Workspace')).not.toContain('::')
    }
  )

  it.each(['duplicate', 'truncated', 'omitted', 'missing', 'replaced'] as const)(
    'does not borrow a workspace label from %s inventory',
    async (problem) => {
      const targets = twins()
      if (problem === 'duplicate') {
        targets.workspaces.push({ ...targets.workspaces[1]! })
      }
      if (problem === 'truncated') {
        targets.coverage.truncated = true
      }
      if (problem === 'omitted') {
        targets.coverage.hostScope.omittedHostIds = ['ssh:builder']
      }
      if (problem === 'missing') {
        targets.workspaces = [targets.workspaces[0]!]
      }
      if (problem === 'replaced') {
        targets.sshTargets[0]!.generation = 8
      }
      inventory.targets.mockResolvedValue(targets)
      await mount(
        portFor(
          { ...savedAutomation(), workspaceId: 'repo-1::/repo' },
          { kind: 'ssh', targetId: 'builder', targetGeneration: 7 }
        )
      )
      expect(metadata('Workspace')).toBe('Unavailable')
      if (problem === 'replaced') {
        expect(metadata('Project')).toBe('Unavailable')
      }
      expect(root().findAll((node) => String(node.type) === 'Switch')[0]!.props.disabled).toBe(
        false
      )
    }
  )

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

  it('refreshes labels on reconnect and rejects late acquisition from a prior generation', async () => {
    const before = deferred<AutomationTargets>()
    const after = deferred<AutomationTargets>()
    inventory.targets.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    const port = portFor()
    await mount(port)
    await act(async () => port.state('disconnected'))
    await act(async () => port.state('connected'))
    expect(inventory.targets).toHaveBeenCalledTimes(2)
    const fresh = automationTargets()
    fresh.workspaces[0]!.displayName = 'Current workspace'
    await act(async () => after.resolve(fresh))
    expect(metadata('Workspace')).toBe('Current workspace')
    await act(async () => before.resolve(automationTargets()))
    expect(metadata('Workspace')).toBe('Current workspace')
    await act(async () => port.event({ type: 'automationsChanged' }))
    expect(inventory.targets).toHaveBeenCalledTimes(2)
  })

  it('cannot publish labels acquired by a replaced client or an unmounted detail', async () => {
    const oldRead = deferred<AutomationTargets>()
    const currentRead = deferred<AutomationTargets>()
    inventory.targets.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise)
    const oldPort = portFor()
    const currentPort = portFor()
    let update = (_client: RpcClient) => {}
    let unmount = () => {}
    await act(async () => {
      const tree = create(
        createElement(AutomationManager, { client: oldPort.client, hostId: 'desktop' })
      )
      setTree(tree)
      update = (client) =>
        tree.update(createElement(AutomationManager, { client, hostId: 'desktop' }))
      unmount = () => tree.unmount()
    })
    await open()
    await act(async () => update(currentPort.client))
    expect(inventory.targets.mock.calls.map((call) => call[0])).toEqual([
      oldPort.client,
      currentPort.client
    ])
    await act(async () => oldRead.resolve(automationTargets()))
    expect(metadata('Workspace')).toBe('Unavailable')
    await act(async () => unmount())
    await act(async () => currentRead.resolve(automationTargets()))
    const fresh = automationTargets()
    fresh.workspaces[0]!.displayName = 'Newly mounted workspace'
    inventory.targets.mockResolvedValue(fresh)
    await mount(portFor())
    expect(metadata('Workspace')).toBe('Newly mounted workspace')
  })

  it('applies literal keyboard policy and the web font floor to actual editor inputs and saves their exact text', async () => {
    const port = portFor({ ...savedAutomation(), reuseSession: false })
    await mount(port)
    await press('Edit')
    const assertInput = (label: string, literal: boolean) => {
      const field = input(label)
      expect(field.props.autoCapitalize).toBe('none')
      for (const prop of ['autoCorrect', 'spellCheck', 'smartInsertDelete']) {
        expect(field.props[prop]).toBe(literal ? false : undefined)
      }
      expect(field.props.autoComplete).toBe(literal ? 'off' : undefined)
      expect(TEXT_INPUT_FONT_SIZE).toBeGreaterThanOrEqual(16)
      expect(field.props.style.flat()).toContainEqual(
        expect.objectContaining({ fontSize: TEXT_INPUT_FONT_SIZE })
      )
      return field
    }
    assertInput('Name', false)
    expect(assertInput('Instructions', false).props.multiline).toBe(true)
    await press('Advanced options')
    const extraAgentArgs = '--model "gpt-6.1-sol" -c model_reasoning_effort="high"'
    const command = 'printf "%s" "résumé -- unchanged"'
    assertInput('Extra agent arguments', true)
    assertInput('Precheck command (optional)', true)
    expect(assertInput('Precheck timeout (seconds)', true).props.keyboardType).toBe('numeric')
    assertInput('Missed-run grace (minutes)', true)
    await act(async () => {
      input('Extra agent arguments').props.onChangeText(extraAgentArgs)
      input('Precheck command (optional)').props.onChangeText(command)
    })
    await press('Continue')
    assertInput('Cron or RRULE', true)
    assertInput('Time zone', true)
    await act(async () =>
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Cadence')!
        .props.onSelect('daily')
    )
    assertInput('Time (HH:MM, 24 hour)', true)
    await act(async () =>
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Cadence')!
        .props.onSelect('custom')
    )
    await act(async () => input('Cron or RRULE').props.onChangeText(savedAutomation().rrule))
    await press('Continue')
    await press('Save changes')
    expect(port.send).toHaveBeenCalledWith(
      'automation.update',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'self' } },
        updates: { extraAgentArgs, precheck: { command, timeoutSeconds: 120 } }
      },
      { failWhenDisconnected: true }
    )
    await press('Edit')
    await act(async () =>
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Workspace')!
        .props.onSelect('new_per_run')
    )
    await press('Advanced options')
    assertInput('Base branch (optional)', true)
  })
}
