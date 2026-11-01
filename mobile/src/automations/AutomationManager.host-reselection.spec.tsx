import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, type vi } from 'vitest'
import { AutomationManager } from './AutomationManager'
import { AutomationList } from './AutomationList'
import { AutomationChoice, AutomationField } from './AutomationControls'
import { automationSetupKey } from './automation-target-inventory'
import {
  automationClient,
  automationTargets,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'

export function registerAutomationHostReselectionTests({
  inventory,
  root,
  press,
  setTree
}: {
  inventory: { targets: ReturnType<typeof vi.fn>; agents: ReturnType<typeof vi.fn> }
  root: () => ReactTestInstance
  press: (label: string) => Promise<void>
  setTree: (tree: ReactTestRenderer) => void
}): void {
  it('sends the captured orphan and chosen SSH destination only after actual host selection', async () => {
    const targets = automationTargets()
    const setup = { ...targets.setups[0]!, hostId: 'ssh:builder' as const }
    targets.setups = [setup]
    targets.workspaces = []
    targets.sshTargets = [{ id: 'builder', label: 'Builder', generation: 7 }]
    inventory.targets.mockResolvedValue(targets)
    inventory.agents.mockResolvedValue([])
    let current = {
      ...savedAutomation(),
      runContext: null,
      agentId: 'claude' as const,
      executionTargetType: 'local',
      executionTargetId: 'local',
      workspaceMode: 'new_per_run' as const,
      workspaceId: null,
      reuseSession: false
    }
    const orphan = {
      kind: 'orphan' as const,
      issue: 'Edit this automation and reselect its host before running it.'
    }
    const port = automationClient((method, params) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      if (method === 'automation.list') {
        return { automations: [current], items: [{ automationId: current.id, selector: orphan }] }
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
      throw new Error(`Unexpected request: ${method}`)
    })
    await act(async () => {
      setTree(create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' })))
    })
    await act(async () => {
      const list = root().findByType(AutomationList)
      list.props.onOpen(list.props.rows[0])
    })
    await press('Edit')
    await act(async () => {
      root()
        .findAllByType(AutomationField)
        .find((field) => field.props.label === 'Name')!
        .props.onChange('Renamed')
    })
    await press('Continue')
    await press('Continue')
    await press('Save changes')
    expect(port.send).toHaveBeenCalledWith(
      'automation.update',
      {
        id: current.id,
        expectedOwner: { selector: { kind: 'orphan' } },
        updates: { name: 'Renamed' }
      },
      expect.anything()
    )
    await press('Edit')
    await act(async () => {
      root()
        .findAllByType(AutomationChoice)
        .find((choice) => choice.props.label === 'Project and host setup')!
        .props.onSelect(automationSetupKey(setup))
    })
    await press('Continue')
    await press('Continue')
    await press('Save changes')
    const requests = port.send.mock.calls.filter(([method]) => method === 'automation.update')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.[1]).toEqual({
      id: current.id,
      expectedOwner: { selector: { kind: 'orphan' } },
      destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } },
      updates: {
        repo: 'id:repo-1',
        workspace: undefined,
        workspaceMode: 'new_per_run',
        runContext: {
          kind: 'workspace-run',
          projectId: setup.projectId,
          projectHostSetupId: setup.id,
          repoId: setup.repoId,
          path: setup.path,
          hostId: setup.hostId
        }
      }
    })
    expect(current).toMatchObject({
      enabled: false,
      agentId: 'claude',
      rrule: savedAutomation().rrule,
      timezone: savedAutomation().timezone,
      dtstart: savedAutomation().dtstart,
      extraAgentArgs: '--model saved',
      sourceContext: savedAutomation().sourceContext,
      futureField: 'keep me'
    })
  })
}
