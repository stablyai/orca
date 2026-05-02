import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { detectDockerEngine } from '../docker/docker-engine-detect'
import { buildDockerImage } from '../docker/docker-image-build'
import { DockerEngineClient } from '../docker/docker-engine-client'
import type { DockerEngineInfo } from '../docker/types'
import type { DockerBuildProgress, DockerEngineStatus, WorktreeIsolation } from '../../shared/types'

const ENGINE_STATUS_CACHE_MS = 30_000
const SSH_DOCKER_ISOLATION_ERROR =
  'Docker isolation is not yet supported for SSH repositories. Use a local repo or remove the SSH connection.'

type DockerIpcStore = Pick<Store, 'getRepo' | 'setWorktreeMeta'>

type DockerIpcDependencies = {
  detectEngine?: () => DockerEngineInfo
  buildImage?: typeof buildDockerImage
  createEngineClient?: () => DockerEngineClient
  now?: () => number
}

let cachedEngineStatus: { value: DockerEngineStatus; expiresAt: number } | null = null

export function clearDockerEngineStatusCache(): void {
  cachedEngineStatus = null
}

export function registerDockerIpcHandlers(
  mainWindow: BrowserWindow,
  store: DockerIpcStore,
  dependencies: DockerIpcDependencies = {}
): void {
  ipcMain.removeHandler('docker:engine-status')
  ipcMain.removeHandler('docker:build-image')
  ipcMain.removeHandler('docker:set-worktree-isolation')

  const now = dependencies.now ?? Date.now
  const detectEngine = dependencies.detectEngine ?? detectDockerEngine
  const createEngineClient = dependencies.createEngineClient ?? (() => new DockerEngineClient())
  const buildImage = dependencies.buildImage ?? buildDockerImage

  ipcMain.handle('docker:engine-status', () => {
    const timestamp = now()
    if (cachedEngineStatus && cachedEngineStatus.expiresAt > timestamp) {
      return cachedEngineStatus.value
    }

    const detected = detectEngine()
    const value: DockerEngineStatus = {
      available: detected.available,
      flavor: detected.flavor,
      ...(detected.reason ? { reason: detected.reason } : {})
    }
    cachedEngineStatus = { value, expiresAt: timestamp + ENGINE_STATUS_CACHE_MS }
    return value
  })

  ipcMain.handle(
    'docker:build-image',
    async (_event, args: { repoId: string; worktreeId: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }
      // Why: SSH repo paths live on the remote host; local Docker builds must
      // not interpret them as local filesystem paths.
      if (repo.connectionId) {
        return { error: SSH_DOCKER_ISOLATION_ERROR }
      }

      const engineStatus = detectEngine()
      if (!engineStatus.available) {
        const reason = engineStatus.reason ?? 'Docker is not available'
        sendBuildProgress(mainWindow, {
          worktreeId: args.worktreeId,
          phase: 'failed',
          error: reason
        })
        throw new Error(reason)
      }

      try {
        sendBuildProgress(mainWindow, { worktreeId: args.worktreeId, phase: 'pull', percent: 5 })
        sendBuildProgress(mainWindow, { worktreeId: args.worktreeId, phase: 'build', percent: 25 })
        const image = await buildImage({
          repoPath: repo.path,
          repoIdentity: repo.id,
          engine: createEngineClient()
        })
        sendBuildProgress(mainWindow, { worktreeId: args.worktreeId, phase: 'ready', percent: 100 })
        return image
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendBuildProgress(mainWindow, {
          worktreeId: args.worktreeId,
          phase: 'failed',
          error: message
        })
        throw error
      }
    }
  )

  ipcMain.handle(
    'docker:set-worktree-isolation',
    (_event, args: { worktreeId: string; isolation: WorktreeIsolation }) => {
      if (args.isolation !== 'host' && args.isolation !== 'docker') {
        throw new Error(`Invalid isolation: ${String(args.isolation)}`)
      }
      return store.setWorktreeMeta(args.worktreeId, { isolation: args.isolation })
    }
  )
}

function sendBuildProgress(mainWindow: BrowserWindow, progress: DockerBuildProgress): void {
  if (mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('docker:build-progress', progress)
}
