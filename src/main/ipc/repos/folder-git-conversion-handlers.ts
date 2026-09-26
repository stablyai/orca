import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { convertLocalFolderToGit } from '../../git/convert-local-folder-to-git'
import { convertRemoteFolderToGit } from '../../git/convert-remote-folder-to-git'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'
import { addLocalRepoFromPath } from './local-repo-registration'
import { addRemoteRepoFromPath } from './remote-repo-registration'
import { resolveRemoteHomePath } from './remote-home-path'

async function convertLocalFolderToGitRepo(
  store: Store,
  path: string
): Promise<{ repo: Repo } | { error: string }> {
  const conversion = await convertLocalFolderToGit(path)
  if (!conversion.ok) {
    return { error: conversion.error }
  }
  const result = await addLocalRepoFromPath(store, path, 'git')
  if ('error' in result) {
    return result
  }
  emitRepoAdded('folder_picker', result.alreadyExisted, true)
  return { repo: result.repo }
}

async function convertRemoteFolderToGitRepo(
  store: Store,
  args: { connectionId: string; remotePath: string }
): Promise<{ repo: Repo } | { error: string }> {
  const gitProvider = getSshGitProvider(args.connectionId)
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!gitProvider || !fsProvider) {
    return { error: `SSH connection "${args.connectionId}" not found or not connected` }
  }
  const host = gitProvider.getHostPlatform?.()
  if (!host) {
    return {
      error: 'SSH host platform is unavailable. Reconnect the SSH target before converting.'
    }
  }
  const resolvedPath = await resolveRemoteHomePath(args.connectionId, args.remotePath ?? '')
  const conversion = await convertRemoteFolderToGit({
    connectionId: args.connectionId,
    path: resolvedPath,
    host,
    gitProvider,
    fsProvider
  })
  if (!conversion.ok) {
    return { error: conversion.error }
  }
  const result = await addRemoteRepoFromPath(store, {
    connectionId: args.connectionId,
    remotePath: conversion.repoPath,
    kind: 'git'
  })
  if ('error' in result) {
    return result
  }
  emitRepoAdded('folder_picker', result.alreadyExisted, true)
  return { repo: result.repo }
}

// Converts a tracked non-git folder into a git project in place (orca#3839).
export function registerFolderGitConversionHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle(
    'repos:convertToGit',
    async (_event, args: { path: string }): Promise<{ repo: Repo } | { error: string }> => {
      const result = await convertLocalFolderToGitRepo(store, args.path)
      if ('error' in result) {
        return result
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'repos:convertRemoteToGit',
    async (
      _event,
      args: { connectionId: string; remotePath: string }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await convertRemoteFolderToGitRepo(store, args)
      if ('error' in result) {
        return result
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )
}
