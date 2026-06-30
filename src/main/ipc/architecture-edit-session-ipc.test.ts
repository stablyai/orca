import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import {
  defaultArchitectureDeps,
  registerArchitectureHandlers,
  type ArchitectureIpcRegistrar
} from './architecture'
import type { ScryerEditSessionController } from '../scryer/edit-session-controller'

function registrar(): ArchitectureIpcRegistrar {
  handlers.clear()
  return {
    handle: (channel, handler) => {
      handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
    }
  }
}

describe('Architecture edit-session IPC handlers', () => {
  it('routes edit-session IPC channels through ScryerEditSessionController', async () => {
    const projectPath = '/repo'
    const sender = { send: vi.fn() }
    const controller: ScryerEditSessionController = {
      beginAgentEditSession: vi.fn(async () => ({
        projectPath,
        agentRunId: 'run-1'
      })),
      completeAgentEditSession: vi.fn(async () => ({
        ok: true,
        foldAllowed: true,
        nextAction: 'fold_allowed' as const,
        pending: {
          total: 1,
          foldable: true,
          byKind: { node: 1 },
          byChange: { added: 1 },
          changes: [],
          blockers: [],
          risks: []
        },
        validation: { blockingCount: 0, warningCount: 0, findings: [] },
        lease: { active: true, blocked: false, owner: 'agent' as const, agentRunId: 'run-1' }
      })),
      cancelAgentEditSession: vi.fn(async () => undefined),
      readEditSession: vi.fn(async () => ({
        projectPath,
        activeLease: { owner: 'agent' as const, agentRunId: 'run-1' }
      }))
    }
    const finishSync = vi.fn(defaultArchitectureDeps.finishSync)
    registerArchitectureHandlers(registrar(), {
      ...defaultArchitectureDeps,
      finishSync,
      scryerEditSessionController: controller
    })

    await expect(
      handlers.get('architecture:beginEditSession')!(null, { projectPath, agentRunId: 'run-1' })
    ).resolves.toEqual({ projectPath, agentRunId: 'run-1' })
    await expect(
      handlers.get('architecture:completeEditSession')!(
        { sender },
        { projectPath, agentRunId: 'run-1', foldPolicy: 'when_gate_passes' }
      )
    ).resolves.toMatchObject({ nextAction: 'fold_allowed' })
    await expect(
      handlers.get('architecture:readEditSession')!(null, { projectPath })
    ).resolves.toMatchObject({ activeLease: { owner: 'agent', agentRunId: 'run-1' } })
    await expect(
      handlers.get('architecture:readEditSession')!(null, { projectPath })
    ).resolves.not.toHaveProperty('activeLease.token')
    await handlers.get('architecture:cancelEditSession')!(null, {
      projectPath,
      agentRunId: 'run-1'
    })

    expect(controller.beginAgentEditSession).toHaveBeenCalledWith({
      projectPath,
      agentRunId: 'run-1'
    })
    expect(controller.completeAgentEditSession).toHaveBeenCalledWith({
      projectPath,
      agentRunId: 'run-1',
      foldPolicy: 'when_gate_passes'
    })
    expect(controller.cancelAgentEditSession).toHaveBeenCalledWith({
      projectPath,
      agentRunId: 'run-1'
    })
    expect(finishSync).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'model.scry'
    })
  })

  it('blocks legacy default model writes while a Scryer edit session is active', async () => {
    const projectPath = '/repo'
    const writeModel = vi.fn(defaultArchitectureDeps.writeModel)
    const writeModelDocument = vi.fn(defaultArchitectureDeps.writeModelDocument)
    const controller: ScryerEditSessionController = {
      beginAgentEditSession: vi.fn(),
      completeAgentEditSession: vi.fn(),
      cancelAgentEditSession: vi.fn(),
      readEditSession: vi.fn(async () => ({
        projectPath,
        activeLease: { owner: 'agent' as const, agentRunId: 'run-1' }
      }))
    }
    registerArchitectureHandlers(registrar(), {
      ...defaultArchitectureDeps,
      writeModel,
      writeModelDocument,
      scryerEditSessionController: controller
    })

    await expect(
      handlers.get('architecture:writeModel')!(null, {
        projectPath,
        model: { projectPath, nodes: [], edges: [], sourceMap: {} }
      })
    ).rejects.toThrow('Scryer edit session is active')
    await expect(
      handlers.get('architecture:writeModelDocument')!(null, {
        projectPath,
        model: { projectPath, nodes: [], edges: [], sourceMap: {} }
      })
    ).rejects.toThrow('Scryer edit session is active')
    expect(writeModel).not.toHaveBeenCalled()
    expect(writeModelDocument).not.toHaveBeenCalled()
  })
})
