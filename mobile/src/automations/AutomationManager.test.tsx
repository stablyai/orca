import { registerAutomationPresentationTests } from './AutomationManager.presentation.spec'
import { registerAutomationHostReselectionTests } from './AutomationManager.host-reselection.spec'
import { registerAutomationRunHistoryTests } from './AutomationManager.run-history.spec'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { AutomationEditor } from './AutomationEditor'
import { automationUpdateParams } from './automation-draft'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationManager } from './AutomationManager'
import { AutomationButton, AutomationChoice, AutomationField } from './AutomationControls'
import { AutomationRunDetails } from './AutomationRunDetails'
import { AutomationRunList } from './AutomationRunList'
import { automationSetupKey } from './automation-target-inventory'
import type * as AutomationInventoryModule from './automation-target-inventory'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import {
  deferred,
  automationClient,
  automationRepo,
  automationTargets,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  TextInput: 'TextInput',
  StyleSheet: { create: <T,>(styles: T) => styles },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock(
  '../platform/text-input-font-size',
  async () => await import('../platform/text-input-font-size.web')
)
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  CalendarClock: 'CalendarClock',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: inventory.push })
}))
const inventory = vi.hoisted(() => ({ targets: vi.fn(), agents: vi.fn(), push: vi.fn() }))
vi.mock('./automation-target-inventory', async (original) => ({
  ...(await original<typeof AutomationInventoryModule>()),
  loadAutomationTargets: (...args: unknown[]) => inventory.targets(...args),
  loadAutomationAgents: (...args: unknown[]) => inventory.agents(...args)
}))

const actualInventory = await vi.importActual<typeof AutomationInventoryModule>(
  './automation-target-inventory'
)

beforeEach(() => {
  inventory.targets.mockReset().mockImplementation(async () => automationTargets())
  inventory.agents.mockReset().mockResolvedValue([{ agent: 'codex', label: 'Codex' }])
  inventory.push.mockClear()
})
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})
function setTree(value: ReactTestRenderer): void {
  tree = value
}
function root() {
  if (!tree) {
    throw new Error('Not mounted')
  }
  return tree.root
}
async function press(label: string) {
  const button = root()
    .findAllByType(AutomationButton)
    .find((node) => node.props.label === label)
  if (!button || button.props.disabled) {
    throw new Error(`Button unavailable: ${label}`)
  }
  await act(async () => {
    button.props.onPress()
  })
}
function text(node: ReactTestInstance): string {
  return JSON.stringify(node.props.children)
}
async function mount(
  loseCreate: boolean | 'legacy' = false,
  confirmSetup = false,
  repoRow = automationRepo
) {
  const pendingList = deferred<unknown>()
  let created = false
  let automation = savedAutomation()
  const oldRun = savedRun()
  const manualRun = { ...savedRun('manual-run'), status: 'dispatched', trigger: 'manual' }
  let runs = [oldRun]
  const port = automationClient((method, params) => {
    if (method === 'repo.list') {
      return { repos: [repoRow()] }
    }
    if (method === 'repo.hooks') {
      return {
        source: null,
        setupRunPolicy: 'run-by-default',
        setupConfig: confirmSetup ? { command: 'npm ci' } : null,
        setupTrust: confirmSetup ? { contentHash: 'setup-hash', scriptContent: 'npm ci' } : null
      }
    }
    if (method === 'ui.get') {
      return { ui: { trustedOrcaHooks: {} } }
    }
    if (method === 'ui.set') {
      return { ui: params }
    }
    if (method === 'status.get') {
      return {
        capabilities:
          loseCreate === true || confirmSetup
            ? [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]
            : []
      }
    }
    if (method === 'automation.list') {
      if (created && loseCreate) {
        return pendingList.promise
      }
      return {
        automations: [automation],
        items: [
          {
            automationId: automation.id,
            selector: { kind: 'self' }
          }
        ]
      }
    }
    if (method === 'automation.runs') {
      return { runs }
    }
    if (method === 'automation.runNow') {
      runs = [manualRun, oldRun]
      return { run: manualRun }
    }
    if (method === 'automation.show') {
      return { automation }
    }
    if (method === 'automation.update') {
      if (
        params &&
        typeof params === 'object' &&
        'updates' in params &&
        params.updates &&
        typeof params.updates === 'object'
      ) {
        automation = { ...automation, ...params.updates }
      }
      return { automation }
    }
    if (method === 'automation.create') {
      automation = {
        ...automation,
        id: 'created',
        name: 'Daily review',
        enabled: true,
        ...(params && typeof params === 'object' ? params : {}),
        baseBranch: null,
        workspaceId: null
      }
      created = true
      if (loseCreate) {
        throw markRpcDeliveryUnknown(new Error('reply lost'))
      }
      return { automation }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
  await act(async () => {
    tree = create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' }))
  })
  return {
    ...port,
    reconcile: () => {
      automation = { ...automation, enabled: false, futureField: 'external edit' }
      pendingList.resolve({
        automations: [automation],
        items: [{ automationId: automation.id, selector: { kind: 'self' } }]
      })
    }
  }
}

describe('mobile automation navigation and setup', () => {
  registerAutomationRunHistoryTests({ mount, root, press })
  registerAutomationPresentationTests({ inventory, root, press, setTree, mount })
  registerAutomationHostReselectionTests({
    inventory,
    root,
    press,
    setTree
  })

  it('preserves edited target values through same selections and away/back adoption', async () => {
    const targets = automationTargets()
    const setup = targets.setups[0]!
    const other = { ...setup, id: 'other-setup', repoId: 'other-repo', path: '/other' }
    targets.setups.push(other)
    targets.workspaces.push({ ...targets.workspaces[0]!, worktreeId: 'workspace-2' })
    inventory.targets.mockResolvedValue(targets)
    const current = Object.assign(savedAutomation(), {
      agentId: 'claude' as const,
      reuseSession: false,
      extraAgentArgs: ''
    })
    const save = vi.fn()
    const port = automationClient(() => ({}))
    await act(async () => {
      tree = create(
        createElement(AutomationEditor, {
          client: port.client,
          current,
          connected: true,
          busy: false,
          capabilities: [],
          onCancel: vi.fn(),
          onDraftChange: vi.fn(),
          onSave: save
        })
      )
    })
    const choice = (label: string) =>
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === label)!
    await press('Advanced options')
    await act(async () => {
      choice('Agent').props.onSelect('codex')
      root()
        .findAll(
          (node) =>
            node.props.accessibilityLabel === 'Reuse agent session' &&
            String(node.type) === 'Switch'
        )[0]!
        .props.onValueChange(true)
    })
    for (const [label, same, away] of [
      ['Project and host setup', automationSetupKey(setup), automationSetupKey(other)],
      ['Workspace', 'existing', 'new_per_run'],
      ['Existing workspace', 'workspace-1', 'workspace-2']
    ]) {
      await act(async () => {
        choice(label!).props.onSelect(same)
      })
      await act(async () => {
        choice(label!).props.onSelect(away)
      })
      await act(async () => {
        choice(label!).props.onSelect(same)
      })
    }
    expect(choice('Agent').props.value).toBe('codex')
    expect(choice('Existing workspace').props.value).toBe('workspace-1')
    await press('Continue')
    await press('Continue')
    await press('Save changes')
    const [draft, original] = save.mock.calls[0]!
    expect(draft).toMatchObject({
      agentId: 'codex',
      reuseSession: true,
      extraAgentArgs: '',
      workspaceId: 'workspace-1',
      targetEdited: true,
      rrule: current.rrule,
      timezone: current.timezone
    })
    expect(automationUpdateParams(current.id, draft, original, targets)).toMatchObject({
      destination: { selector: { kind: 'self' } },
      updates: { agentId: 'codex', reuseSession: true, workspace: 'id:workspace-1' }
    })
  })

  it.each(['success', 'failure'] as const)(
    'keeps acquisition B authoritative after late A %s with copied target IDs',
    async (late) => {
      const targets = automationTargets()
      const a = targets.setups[0]!
      const b = { ...a, hostId: 'ssh:builder' as const }
      inventory.targets.mockResolvedValue({
        ...targets,
        setups: [a, b],
        workspaces: ['local', 'ssh:builder'].map((hostId) => ({
          worktreeId: 'repo-1::/repo',
          repoId: a.repoId,
          path: a.path,
          displayName: 'Copied workspace',
          hostId
        }))
      })
      const pendingA =
        deferred<Awaited<ReturnType<typeof AutomationInventoryModule.loadAutomationAgents>>>()
      const pendingB =
        deferred<Awaited<ReturnType<typeof AutomationInventoryModule.loadAutomationAgents>>>()
      inventory.agents.mockImplementation((_client, selected: typeof a) =>
        selected.hostId === 'local' ? pendingA.promise : pendingB.promise
      )
      const port = automationClient(() => ({}))
      await act(async () => {
        tree = create(
          createElement(AutomationEditor, {
            client: port.client,
            current: {
              ...savedAutomation(),
              workspaceId: 'repo-1::/repo',
              runContext: {
                kind: 'workspace-run',
                projectId: a.projectId,
                projectHostSetupId: a.id,
                repoId: a.repoId,
                hostId: a.hostId,
                path: a.path
              }
            },
            busy: false,
            connected: true,
            capabilities: [],
            onCancel: vi.fn(),
            onDraftChange: vi.fn(),
            onSave: vi.fn()
          })
        )
      })
      const choice = (label: string) =>
        root()
          .findAllByType(AutomationChoice)
          .find((node) => node.props.label === label)!
      await act(async () => {
        choice('Project and host setup').props.onSelect(automationSetupKey(b))
      })
      await act(async () => {
        choice('Existing workspace').props.onSelect('repo-1::/repo')
      })
      expect(inventory.agents.mock.calls.map((call) => [call[1].hostId, call[2]])).toEqual([
        ['local', 'repo-1::/repo'],
        ['ssh:builder', undefined],
        ['ssh:builder', 'repo-1::/repo']
      ])
      await act(async () => {
        if (late === 'success') {
          pendingA.resolve([{ agent: 'claude', label: 'Stale A' }])
        } else {
          pendingA.reject(new Error('stale A failed'))
        }
      })
      expect(choice('Agent · detecting…').props.disabled).toBe(true)
      expect(choice('Agent · detecting…').props.options).toEqual([
        { value: 'codex', label: 'Codex (saved)' }
      ])
      expect(
        root()
          .findAllByType(AutomationButton)
          .find((node) => node.props.label === 'Continue')?.props.disabled
      ).toBe(true)
      await act(async () => {
        pendingB.resolve([{ agent: 'codex', label: 'Current B' }])
      })
      expect(choice('Agent').props.options).toEqual([{ value: 'codex', label: 'Current B' }])
      expect(choice('Agent').props.disabled).toBe(false)
      expect(
        root().findAll(
          (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
        )
      ).toHaveLength(0)
      expect(choice('Project and host setup').props.value).toBe(automationSetupKey(b))
    }
  )

  it('renders unserved SSH discovery truthfully without local probes or replacing a saved agent', async () => {
    inventory.agents.mockImplementation(actualInventory.loadAutomationAgents)
    const targets = automationTargets()
    const ssh = { ...targets.setups[0]!, hostId: 'ssh:builder' as const }
    inventory.targets.mockResolvedValue({ ...targets, setups: [ssh] })
    const current = {
      ...savedAutomation(),
      agentId: 'claude' as const,
      runContext: {
        kind: 'workspace-run' as const,
        projectId: ssh.projectId,
        projectHostSetupId: ssh.id,
        repoId: ssh.repoId,
        path: ssh.path,
        hostId: ssh.hostId
      }
    }
    const port = automationClient(() => {
      throw new Error('unexpected local probe')
    })
    const props = {
      client: port.client,
      current,
      busy: false,
      connected: true,
      capabilities: [],
      onCancel: vi.fn(),
      onDraftChange: vi.fn(),
      onSave: vi.fn()
    }
    await act(async () => {
      tree = create(createElement(AutomationEditor, props))
    })
    expect(port.send).not.toHaveBeenCalled()
    const labels = root()
      .findAll((node) => String(node.type) === 'Text')
      .map(text)
      .join(' ')
    expect(labels).toContain(
      'Agent discovery is unavailable for this project host. Saved agent choices are preserved.'
    )
    expect(labels).not.toContain('Install and enable')
    expect(
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Agent')?.props.options
    ).toContainEqual({ value: 'claude', label: 'Claude (saved)' })
    await act(async () => {
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === 'Name')!
        .props.onChange('Renamed SSH automation')
    })
    await press('Continue')
    await press('Continue')
    await press('Save changes')
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Renamed SSH automation',
        agentId: 'claude',
        extraAgentArgs: current.extraAgentArgs,
        reuseSession: true
      }),
      expect.anything(),
      expect.anything()
    )
    expect(port.send).not.toHaveBeenCalled()
    await act(async () => {
      tree?.unmount()
      tree = null
    })
    await act(async () => {
      tree = create(createElement(AutomationEditor, { ...props, current: undefined }))
    })
    const newLabels = root()
      .findAll((node) => String(node.type) === 'Text')
      .map(text)
      .join(' ')
    expect(newLabels).toContain('Agent discovery is unavailable for this project host.')
    expect(newLabels).not.toContain('Install and enable')
    expect(port.send).not.toHaveBeenCalled()
  })

  it('hands the verified original pane to the served-page router and refuses a replacement PTY', async () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const paneKey = `original-tab:${leaf}`
    const run = {
      ...savedRun(),
      workspaceId: 'repo::/same path',
      terminalPaneKey: paneKey,
      terminalPtyId: 'original-pty'
    }
    let ptyId = 'original-pty'
    const port = automationClient(() => ({
      terminals: [
        {
          handle: 'active',
          worktreeId: run.workspaceId,
          connected: true,
          tabId: 'active-tab',
          leafId: leaf,
          ptyId: 'active-pty'
        },
        {
          handle: 'original',
          worktreeId: run.workspaceId,
          connected: true,
          tabId: 'original-tab',
          leafId: leaf,
          ptyId
        }
      ],
      totalCount: 2,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }))
    const history = {
      runs: [run],
      selected: run,
      unavailable: false,
      cursor: null,
      loading: false,
      error: null,
      loadMore: vi.fn(),
      reload: vi.fn()
    }
    await act(async () => {
      tree = create(
        createElement(AutomationRunDetails, {
          run,
          client: port.client,
          hostId: 'paired',
          executionHost: 'runtime:server',
          connected: true,
          history,
          onBack: vi.fn()
        })
      )
    })
    await press('Open agent')
    expect(inventory.push).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/session/[worktreeId]',
      params: {
        hostId: 'paired',
        worktreeId: run.workspaceId,
        paneKey,
        name: run.workspaceDisplayName,
        executionHost: 'runtime:server'
      }
    })
    inventory.push.mockClear()
    ptyId = 'replacement-pty'
    await press('Open agent')
    expect(inventory.push).not.toHaveBeenCalled()
    expect(
      root()
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => text(node).includes('original agent pane is no longer available'))
    ).toBe(true)
  })

  it.each(['*/90 * * * *', '17 * * * *'])(
    'keeps initialized input and unedited saved values through inventory revival (%s)',
    async (rrule) => {
      const delayed = deferred<ReturnType<typeof automationTargets>>()
      inventory.targets.mockImplementationOnce(() => delayed.promise)
      const current = {
        ...savedAutomation(),
        rrule,
        timezone: 'Saved/FutureZone',
        precheck: { command: 'saved check', timeoutSeconds: 999999 },
        agentId: 'claude' as const
      }
      const onSave = vi.fn()
      const port = automationClient(() => ({}))
      const props = {
        client: port.client,
        current,
        busy: false,
        connected: true,
        capabilities: [],
        onCancel: vi.fn(),
        onDraftChange: vi.fn(),
        onSave
      }
      await act(async () => {
        tree = create(createElement(AutomationEditor, props))
      })
      const field = (label: string) =>
        root()
          .findAllByType(AutomationField)
          .find((node) => node.props.label === label)!
      expect(field('Name').props.disabled).toBe(true)
      await act(async () => {
        delayed.resolve(automationTargets())
      })
      await act(async () => {
        field('Name').props.onChange('Accepted name')
      })
      await act(async () => {
        tree?.update(createElement(AutomationEditor, { ...props, connected: false }))
      })
      await act(async () => {
        tree?.update(createElement(AutomationEditor, props))
      })
      expect(field('Name').props.value).toBe('Accepted name')
      const agent = root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Agent')!
      expect(agent.props.options).toContainEqual({ value: 'claude', label: 'Claude (saved)' })
      await press('Continue')
      if (rrule === '17 * * * *') {
        expect(field('Minute (from HH:MM)').props.value).toBe('09:17')
        await act(async () => {
          field('Minute (from HH:MM)').props.onChange('10:17')
        })
      }
      await press('Continue')
      await press('Save changes')
      const [draft, original, targets] = onSave.mock.calls[0]!
      expect(automationUpdateParams(current.id, draft, original, targets)).toEqual({
        id: current.id,
        updates: { name: 'Accepted name' }
      })
      expect(draft.agentId).toBe('claude')
      expect(current.enabled).toBe(false)
    }
  )

  it('opens exact historical and returned manual runs with explicit paths back', async () => {
    const port = await mount()
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('runs')
    })
    const runList = root().findByType(AutomationRunList)
    const runRow = runList
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.props.accessibilityLabel?.startsWith('Review changes,'))
    if (!runRow) {
      throw new Error('History row missing')
    }
    await act(async () => {
      runRow.props.onPress()
    })
    expect(root().findByType(AutomationRunDetails).props.run.id).toBe('run-old')
    expect(
      root()
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => text(node).includes('Output for run-old'))
    ).toBe(true)
    await press('All runs')
    expect(root().findByType(AutomationRunList)).toBeTruthy()
    expect(
      port.send.mock.calls
        .filter(([method]) => method === 'automation.runs')
        .every(([, params]) => JSON.stringify(params) === '{"limit":30}')
    ).toBe(true)
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('automations')
    })
    const entry = root()
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((child) => String(child.type) === 'Text')
          .some((child) => child.props.children === 'Review changes')
      )
    if (!entry) {
      throw new Error('Automation entry missing')
    }
    await act(async () => {
      entry.props.onPress()
    })
    await press('Run now')
    expect(root().findByType(AutomationRunDetails).props.run.id).toBe('manual-run')
    expect(port.send).toHaveBeenCalledWith(
      'automation.runNow',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'self' } }
      },
      { failWhenDisconnected: true }
    )
    await press('All runs')
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('automations')
    })
  })
  it('preserves an uncertain legacy create without issuing a second uncorrelated write', async () => {
    const port = await mount('legacy')
    await press('New automation')
    await act(async () => {
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === 'Name')!
        .props.onChange('Legacy create')
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === 'Instructions')!
        .props.onChange('Keep this draft')
    })
    await press('Continue')
    await press('Continue')
    await press('Create automation')
    await press('Create automation')
    const sent = port.send.mock.calls.filter(([method]) => method === 'automation.create')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.[1]).toMatchObject({ prompt: 'Keep this draft', creationKey: undefined })
    expect(root().findByType(AutomationEditor)).toBeTruthy()
    expect(
      root()
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => text(node).includes('may have applied'))
    ).toBe(true)
  })
  it.each([false, true])(
    'reconciles a lost create reply before explicitly saving only the revised input (reverted=%s)',
    async (reverted) => {
      const targets = automationTargets()
      const sshSetup = {
        ...targets.setups[0]!,
        hostId: 'ssh:builder' as const,
        path: '/remote/repo'
      }
      inventory.targets.mockResolvedValue({
        ...targets,
        setups: [...targets.setups, sshSetup],
        sshTargets: [{ id: 'builder', label: 'Builder', generation: 7 }]
      })
      let inspectionSetup = targets.setups[0]!
      const port = await mount(true, false, () => automationRepo(inspectionSetup))
      await press('New automation')
      const field = (label: string) =>
        root()
          .findAllByType(AutomationField)
          .find((node) => node.props.label === label)!
      await act(async () => {
        field('Name').props.onChange('Daily review')
        field('Instructions').props.onChange('Submitted A')
      })
      await press('Continue')
      await press('Continue')
      await press('Create automation')
      await press('Back')
      await press('Back')
      await act(async () => {
        field('Instructions').props.onChange('Revised B')
        root()
          .findAllByType(AutomationChoice)
          .find((node) => node.props.label === 'Project and host setup')!
          .props.onSelect(automationSetupKey(sshSetup))
      })
      await press('Continue')
      await press('Continue')
      await press('Create automation')
      const attempts = port.send.mock.calls.filter(([method]) => method === 'automation.create')
      expect(attempts).toHaveLength(2)
      expect(attempts[1]?.[1]).toEqual(attempts[0]?.[1])
      if (reverted) {
        await press('Back')
        await press('Back')
        await act(async () => {
          field('Instructions').props.onChange('Submitted A')
          root()
            .findAllByType(AutomationChoice)
            .find((node) => node.props.label === 'Project and host setup')!
            .props.onSelect(automationSetupKey(targets.setups[0]!))
        })
      }
      await act(async () => {
        port.reconcile()
      })
      if (reverted) {
        expect(root().findAllByType(AutomationEditor)).toHaveLength(0)
        expect(
          root()
            .findAll((node) => String(node.type) === 'Text')
            .map(text)
            .join(' ')
        ).toContain('Submitted A')
        expect(
          port.send.mock.calls.filter(([method]) => method === 'automation.create')
        ).toHaveLength(2)
        expect(
          port.send.mock.calls.filter(([method]) => method === 'automation.update')
        ).toHaveLength(0)
        return
      }
      expect(root().findByType(AutomationEditor).props.current.id).toBe('created')
      expect(root().findByType(AutomationEditor).props.initialDraft.prompt).toBe('Revised B')
      expect(
        port.send.mock.calls.filter(([method]) => method === 'automation.create')
      ).toHaveLength(2)
      expect(
        port.send.mock.calls.filter(([method]) => method === 'automation.update')
      ).toHaveLength(0)
      inspectionSetup = sshSetup
      await press('Save changes')
      expect(port.send).toHaveBeenCalledWith(
        'automation.update',
        {
          id: 'created',
          updates: {
            prompt: 'Revised B',
            repo: 'id:repo-1',
            workspace: undefined,
            workspaceMode: 'new_per_run',
            runContext: {
              kind: 'workspace-run',
              projectId: sshSetup.projectId,
              projectHostSetupId: sshSetup.id,
              repoId: sshSetup.repoId,
              path: sshSetup.path,
              hostId: sshSetup.hostId
            }
          },
          destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } },
          expectedOwner: { selector: { kind: 'self' } }
        },
        { failWhenDisconnected: true }
      )
    }
  )
})
