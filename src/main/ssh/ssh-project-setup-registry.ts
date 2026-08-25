import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../shared/project-types'

let setupExistingFolder:
  | ((args: ProjectHostSetupExistingFolderArgs) => Promise<ProjectHostSetupResult>)
  | null = null

export function setSshProjectSetupExistingFolderHandler(
  handler: ((args: ProjectHostSetupExistingFolderArgs) => Promise<ProjectHostSetupResult>) | null
): void {
  setupExistingFolder = handler
}

export async function setupRegisteredSshProjectExistingFolder(
  args: ProjectHostSetupExistingFolderArgs
): Promise<ProjectHostSetupResult> {
  if (!setupExistingFolder) {
    throw new Error('ssh_project_setup_handler_not_registered')
  }
  return setupExistingFolder(args)
}
