import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeRendererSyncWindowGraph } from '../../shared/runtime-types'

const { handleMock, fromWebContentsMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  }
}))

import { registerRuntimeHandlers } from './runtime'

describe('runtime-graph-guard (INV-5: REQ-WPO-05 Anti-Hijack)', () => {
  let mockRuntime: OrcaRuntimeService
  const satelliteSender = { id: 99 }
  const mainSender = { id: 1 }
  const mainFrame = {}

  beforeEach(() => {
    handleMock.mockReset()
    fromWebContentsMock.mockReset()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates partial OrcaRuntimeService mock
    mockRuntime = {
      syncWindowGraph: vi.fn().mockReturnValue({ accepted: true }),
      notifyReposChangedForRemoteClients: vi.fn()
    } as unknown as OrcaRuntimeService

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock accepts unknown sender
    const isWorkspacePopoutRenderer = ((sender: unknown) => sender === satelliteSender) as (
      sender: Electron.WebContents
    ) => boolean

    registerRuntimeHandlers(mockRuntime, {
      isWorkspacePopoutRenderer
    })
  })

  it('rejects runtime:syncWindowGraph from satellite sender before hitting runtime', async () => {
    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    expect(registration).toBeDefined()
    const handler = registration![1]

    const graph: RuntimeRendererSyncWindowGraph = {
      rendererGeneration: 'gen-satellite-1',
      tabs: [],
      leaves: []
    }

    const event = {
      sender: satelliteSender,
      senderFrame: mainFrame
    }

    expect(() => handler(event, graph)).toThrow(
      'Runtime graph sync cannot originate from a satellite window'
    )
    expect(mockRuntime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('rejects runtime:syncWindowGraph from satellite sender even during main window reload (authoritativeWindowId is null)', async () => {
    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    const handler = registration![1]

    // Simulate main window reload race: runtime has no authoritative window
    // and satellite tries to register/sync itself to become authoritative.
    const graph: RuntimeRendererSyncWindowGraph = {
      rendererGeneration: 'gen-satellite-takeover',
      tabs: [],
      leaves: []
    }

    fromWebContentsMock.mockReturnValue({ id: 99 }) // satellite window mock

    const event = {
      sender: satelliteSender,
      senderFrame: mainFrame
    }

    expect(() => handler(event, graph)).toThrow(
      'Runtime graph sync cannot originate from a satellite window'
    )
    expect(mockRuntime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('permits runtime:syncWindowGraph from legitimate main window renderer', async () => {
    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    const handler = registration![1]

    const mainWindow = { id: 1 }
    fromWebContentsMock.mockReturnValue(mainWindow)

    const graph: RuntimeRendererSyncWindowGraph = {
      rendererGeneration: 'gen-main-1',
      tabs: [],
      leaves: []
    }

    const event = {
      sender: { ...mainSender, mainFrame },
      senderFrame: mainFrame
    }

    const result = handler(event, graph)
    expect(result).toEqual({ accepted: true })
    expect(mockRuntime.syncWindowGraph).toHaveBeenCalledWith(1, graph)
  })
})
