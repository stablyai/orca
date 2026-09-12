import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { CommandHandler } from '../dispatch'
import { formatNestedRepoImport, formatNestedRepoScan, printResult } from '../format'
import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime/types'

function getImportMode(flags: Map<string, string | boolean>): ProjectGroupImportMode {
  const mode = getRequiredStringFlag(flags, 'mode')
  if (mode === 'group' || mode === 'separate') {
    return mode
  }
  throw new RuntimeClientError('invalid_argument', 'Invalid --mode. Use group or separate.')
}

export const PROJECT_GROUP_HANDLERS: Record<string, CommandHandler> = {
  'project-group scan-nested': async ({ flags, client, cwd, json }) => {
    const rawPath = getRequiredStringFlag(flags, 'path')
    const path = resolveRepoPathArgument(rawPath, cwd, client.isRemote, 'Remote nested repo scan')
    const result = await client.call<NestedRepoScanResult>('projectGroup.scanNested', { path })
    printResult(result, json, formatNestedRepoScan)
  },
  'project-group import-nested': async ({ flags, client, cwd, json }) => {
    const rawPath = getRequiredStringFlag(flags, 'path')
    const rawProjectPaths = getRepeatedStringFlag(flags, 'project-path')
    if (rawProjectPaths.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing required --project-path; repeat it for each repository to import.'
      )
    }
    const mode = getImportMode(flags)
    const parentPath = resolveRepoPathArgument(
      rawPath,
      cwd,
      client.isRemote,
      'Remote nested repo import'
    )
    const projectPaths = rawProjectPaths.map((projectPath) =>
      resolveRepoPathArgument(
        projectPath,
        cwd,
        client.isRemote,
        'Remote nested repository',
        'project-path'
      )
    )
    const result = await client.call<ProjectGroupImportResult>('projectGroup.importNested', {
      parentPath,
      groupName: getOptionalStringFlag(flags, 'group-name') ?? '',
      projectPaths,
      mode
    })
    printResult(result, json, formatNestedRepoImport)
  }
}
