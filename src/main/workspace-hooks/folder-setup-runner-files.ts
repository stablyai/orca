import { randomUUID } from 'node:crypto'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { windowsFsPath } from '../wsl/filesystem/wsl-unc-drive-fs-path'

const FOLDER_RUNNER_DIR = '.orca'

function runnerPrefix(worktreeId: string): string {
  const separatorIdx = worktreeId.lastIndexOf(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
  const instance =
    separatorIdx === -1
      ? 'root'
      : worktreeId.slice(separatorIdx + FOLDER_WORKSPACE_INSTANCE_SEPARATOR.length)
  return `setup-runner-${instance.replace(/[^A-Za-z0-9-]/g, '_')}-`
}

/** A fresh file per launch: workspaces share the folder, and bash/cmd re-read a runner by offset while it runs. */
export function newFolderSetupRunnerPath(
  folderPath: string,
  worktreeId: string,
  extension: 'sh' | 'cmd'
): string {
  return join(
    folderPath,
    FOLDER_RUNNER_DIR,
    `${runnerPrefix(worktreeId)}${randomUUID()}.${extension}`
  )
}

/** A folder may itself be a Git checkout; keep its runners out of `git status` without editing its files. */
export async function ignoreFolderSetupRunners(runnerDirFsPath: string): Promise<void> {
  await writeFile(join(runnerDirFsPath, '.gitignore'), 'setup-runner-*\n.gitignore\n', {
    flag: 'wx'
  }).catch(() => undefined)
}

/** Call after the workspace's processes stopped, so no running script loses its file. */
export async function removeFolderSetupRunnerFiles(
  folderPath: string,
  worktreeId: string
): Promise<void> {
  const dir = windowsFsPath(join(folderPath, FOLDER_RUNNER_DIR))
  const prefix = runnerPrefix(worktreeId)
  const names: string[] = await readdir(dir).catch((): string[] => [])
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) =>
        unlink(join(dir, name)).catch((error: unknown) => {
          console.warn(`[hooks] could not remove setup runner ${name} in ${dir}:`, error)
        })
      )
  )
}
