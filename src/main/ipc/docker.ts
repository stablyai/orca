import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { detectDockerEngine } from '../docker/docker-engine-detect'
import {
  buildDockerImage,
  getDockerImageCacheIndex,
  isOrcaDockerImageTag,
  ORCA_DOCKER_CACHE_KEY_LABEL,
  ORCA_DOCKER_DOCKERFILE_PATH_LABEL,
  ORCA_DOCKER_IMAGE_LABEL,
  removeDockerImageCacheIndexEntry
} from '../docker/docker-image-build'
import { DockerEngineClient, type DockerEngineClientLike } from '../docker/docker-engine-client'
import type { DockerEngineInfo } from '../docker/types'
import { listRepoWorktrees } from '../repo-worktrees'
import { areWorktreePathsEqual } from './worktree-logic'
import type {
  DockerBuildProgress,
  DockerCachedImage,
  DockerEngineStatus,
  WorktreeIsolation
} from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'

const ENGINE_STATUS_CACHE_MS = 30_000
const SSH_DOCKER_ISOLATION_ERROR =
  'Docker isolation is not yet supported for SSH repositories. Use a local repo or remove the SSH connection.'
const INVALID_WORKTREE_ERROR = 'Docker image builds must target a known worktree for this repo.'

type DockerIpcStore = Pick<Store, 'getRepo' | 'setWorktreeMeta'>

type DockerIpcDependencies = {
  detectEngine?: () => DockerEngineInfo
  buildImage?: typeof buildDockerImage
  createEngineClient?: () => DockerEngineClientLike
  listWorktrees?: typeof listRepoWorktrees
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
  ipcMain.removeHandler('docker:list-cached-images')
  ipcMain.removeHandler('docker:prune-image')

  const now = dependencies.now ?? Date.now
  const detectEngine = dependencies.detectEngine ?? detectDockerEngine
  const createEngineClient = dependencies.createEngineClient ?? (() => new DockerEngineClient())
  const buildImage = dependencies.buildImage ?? buildDockerImage
  const listWorktrees = dependencies.listWorktrees ?? listRepoWorktrees

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
      const parsedWorktreeId = splitWorktreeId(args.worktreeId)
      if (
        !parsedWorktreeId ||
        parsedWorktreeId.repoId !== args.repoId ||
        !parsedWorktreeId.worktreePath
      ) {
        return { error: INVALID_WORKTREE_ERROR }
      }
      const worktrees = await listWorktrees(repo)
      const targetWorktree = worktrees.find((worktree) =>
        areWorktreePathsEqual(worktree.path, parsedWorktreeId.worktreePath)
      )
      if (!targetWorktree) {
        return { error: INVALID_WORKTREE_ERROR }
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
          repoPath: targetWorktree.path,
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
    async (_event, args: { worktreeId: string; isolation: WorktreeIsolation }) => {
      if (args.isolation !== 'host' && args.isolation !== 'docker') {
        throw new Error(`Invalid isolation: ${String(args.isolation)}`)
      }
      if (args.isolation === 'docker') {
        const parsedWorktreeId = splitWorktreeId(args.worktreeId)
        if (!parsedWorktreeId?.worktreePath) {
          return { error: INVALID_WORKTREE_ERROR }
        }
        const repo = store.getRepo(parsedWorktreeId.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${parsedWorktreeId.repoId}`)
        }
        // Why: a forged renderer IPC call must not mark an SSH worktree for
        // local Docker routing even if the visible toggle is disabled.
        if (repo.connectionId) {
          return { error: SSH_DOCKER_ISOLATION_ERROR }
        }
        const worktrees = await listWorktrees(repo)
        const targetWorktree = worktrees.find((worktree) =>
          areWorktreePathsEqual(worktree.path, parsedWorktreeId.worktreePath)
        )
        if (!targetWorktree) {
          return { error: INVALID_WORKTREE_ERROR }
        }
      }
      return store.setWorktreeMeta(args.worktreeId, { isolation: args.isolation })
    }
  )

  ipcMain.handle('docker:list-cached-images', async (): Promise<DockerCachedImage[]> => {
    return listCachedImages(createEngineClient())
  })

  ipcMain.handle('docker:prune-image', async (_event, args: string | { imageId: string }) => {
    const imageId = typeof args === 'string' ? args : args.imageId
    if (!imageId) {
      throw new Error('imageId is required')
    }
    const engine = createEngineClient()
    const inspected = await engine.inspectImage(imageId)
    const cacheKey = inspected.labels[ORCA_DOCKER_CACHE_KEY_LABEL]
    if (
      inspected.labels[ORCA_DOCKER_IMAGE_LABEL] !== 'true' ||
      !cacheKey ||
      !isOrcaDockerImageTag(inspected.repoTags, cacheKey)
    ) {
      throw new Error('Refusing to prune a non-Orca Docker image')
    }
    await engine.removeImage(imageId)
    removeDockerImageCacheIndexEntry(cacheKey)
  })
}

function sendBuildProgress(mainWindow: BrowserWindow, progress: DockerBuildProgress): void {
  if (mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('docker:build-progress', progress)
}

async function listCachedImages(engine: DockerEngineClientLike): Promise<DockerCachedImage[]> {
  const indexByCacheKey = new Map(
    getDockerImageCacheIndex().map((entry) => [entry.cacheKey, entry])
  )
  const images = await engine.listImages({ label: ORCA_DOCKER_IMAGE_LABEL })
  const results = await Promise.all(
    images.map(async (image) => {
      const inspected = await engine.inspectImage(image.id)
      const cacheKey = inspected.labels[ORCA_DOCKER_CACHE_KEY_LABEL]
      if (
        inspected.labels[ORCA_DOCKER_IMAGE_LABEL] !== 'true' ||
        !cacheKey ||
        !isOrcaDockerImageTag(inspected.repoTags, cacheKey)
      ) {
        return null
      }
      const indexed = indexByCacheKey.get(cacheKey)
      return {
        id: inspected.id || image.id,
        cacheKey,
        dockerfilePath:
          inspected.labels[ORCA_DOCKER_DOCKERFILE_PATH_LABEL] ?? indexed?.dockerfilePath ?? '',
        sizeBytes: inspected.sizeBytes,
        lastUsedAt: indexed?.lastUsedAt ?? indexed?.builtAt ?? 0
      }
    })
  )
  return results
    .filter((entry): entry is DockerCachedImage => entry !== null)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
}
