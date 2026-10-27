import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  PROJECT_MOVE_PAUSE_PROTOCOL,
  projectMovePauseResponseSchema,
  type ProjectMovePauseRequest,
  type ProjectMovePauseResponse
} from '../../shared/project-move-pause'
import type { WorkspaceSleepOutcome, WorkspaceSleepRequest } from '../../shared/workspace-sleep'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'

type SleepRuntime = {
  sleepWorkspaces: (request: WorkspaceSleepRequest) => Promise<WorkspaceSleepOutcome[]>
}

/** Known stop receipts survive a renderer failure so the mover can journal partial progress. */
export class ProjectMovePauseError extends Error {
  constructor(
    cause: unknown,
    readonly outcomes: readonly WorkspaceSleepOutcome[]
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ProjectMovePauseError'
  }
}

/** Caller holds the move fence; verify every stop outcome before export and journal partial outcomes on rejection. Main stops; renderer confirms persistence. */
export async function pauseWorkspacesForProjectMove(
  mainWindow: BrowserWindow,
  runtime: SleepRuntime,
  worktreeIds: readonly string[]
): Promise<WorkspaceSleepOutcome[]> {
  const ids = [...new Set(worktreeIds)]
  if (ids.length === 0) {
    return []
  }
  const webContents = mainWindow.webContents
  if (mainWindow.isDestroyed() || webContents.isDestroyed()) {
    throw new Error('project_move_pause_renderer_unavailable')
  }
  const requestId = randomUUID()
  let unavailable = false
  let waiting:
    | {
        finish: (response?: ProjectMovePauseResponse, error?: Error) => void
      }
    | undefined
  const onUnavailable = (): void => {
    unavailable = true
    waiting?.finish(undefined, new Error('project_move_pause_renderer_unavailable'))
  }
  const onNavigation = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean
  ): void => {
    if (mainFrame && !inPlace) {
      onUnavailable()
    }
  }
  const onResponse = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== webContents) {
      return
    }
    const response = projectMovePauseResponseSchema.safeParse(value)
    if (!response.success || response.data.requestId !== requestId) {
      return
    }
    waiting?.finish(response.data)
  }
  const ask = (
    request: ProjectMovePauseRequest,
    timeoutMs: number
  ): Promise<ProjectMovePauseResponse> => {
    if (unavailable) {
      return Promise.reject(new Error('project_move_pause_renderer_unavailable'))
    }
    return new Promise((resolve, reject) => {
      const finish = (response?: ProjectMovePauseResponse, error?: Error): void => {
        clearTimeout(timer)
        waiting = undefined
        if (error) {
          reject(error)
        } else if (response?.phase === 'error') {
          reject(new Error(response.error))
        } else if (response?.phase !== request.phase) {
          reject(new Error('project_move_pause_invalid_phase'))
        } else {
          resolve(response)
        }
      }
      const timer = setTimeout(
        () => finish(undefined, new Error('project_move_pause_renderer_timeout')),
        timeoutMs
      )
      waiting = { finish }
      try {
        webContents.send('ui:projectMovePause', request)
      } catch {
        onUnavailable()
      }
    })
  }
  const releaseListeners = [
    addFanoutListener(ipcMain, 'ui:projectMovePauseResponse', onResponse),
    addFanoutListener(mainWindow, 'closed', onUnavailable),
    addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onUnavailable),
    addFanoutListener(webContents, 'did-start-navigation', onNavigation)
  ]
  const envelope = { requestId, protocol: PROJECT_MOVE_PAUSE_PROTOCOL } as const
  let outcomes: WorkspaceSleepOutcome[] = []
  try {
    const prepared = await ask({ ...envelope, phase: 'prepare', worktreeIds: ids }, 20_000)
    if (
      prepared.phase !== 'prepare' ||
      prepared.targets.length !== ids.length ||
      new Set(prepared.targets.map((target) => target.worktreeId)).size !== ids.length ||
      prepared.targets.some((target) => !ids.includes(target.worktreeId))
    ) {
      throw new Error('project_move_pause_invalid_scope')
    }
    if (unavailable) {
      throw new Error('project_move_pause_renderer_unavailable')
    }
    outcomes = await runtime.sleepWorkspaces({
      targets: prepared.targets,
      markChatsAsleep: false,
      projectMovePauseId: requestId
    })
    if (
      outcomes.length !== ids.length ||
      new Set(outcomes.map((outcome) => outcome.worktreeId)).size !== ids.length ||
      outcomes.some((outcome) => !ids.includes(outcome.worktreeId))
    ) {
      throw new Error('project_move_pause_invalid_outcomes')
    }
    await ask(
      {
        ...envelope,
        phase: 'persist',
        successfulWorktreeIds: outcomes
          .filter((outcome) => !outcome.failure)
          .map((outcome) => outcome.worktreeId)
      },
      120_000
    )
    return outcomes
  } catch (error) {
    throw new ProjectMovePauseError(error, outcomes)
  } finally {
    if (!unavailable) {
      try {
        webContents.send('ui:projectMovePause', { ...envelope, phase: 'release' })
      } catch {
        /* The renderer no longer holds a live reservation. */
      }
    }
    for (const release of releaseListeners) {
      release()
    }
  }
}
