import { basename } from 'node:path'
import type { OpenWithApplicationCandidate } from './open-with-candidate'
import { readOpenWithCommandOutput } from './open-with-command-output'

// Why: LaunchServices has no CLI; the JXA ObjC bridge is the only way to ask
// NSWorkspace for per-file handlers without shipping a native helper.
const LIST_APPLICATIONS_JXA = `
function run(argv) {
  ObjC.import('AppKit')
  const fileUrl = $.NSURL.fileURLWithPath(argv[0])
  const workspace = $.NSWorkspace.sharedWorkspace
  const applicationUrls = workspace.URLsForApplicationsToOpenURL(fileUrl)
  const defaultUrl = workspace.URLForApplicationToOpenURL(fileUrl)
  const applicationPaths = []
  for (let index = 0; index < applicationUrls.count; index += 1) {
    applicationPaths.push(ObjC.unwrap(applicationUrls.objectAtIndex(index).path))
  }
  const defaultPath = defaultUrl.isNil() ? null : ObjC.unwrap(defaultUrl.path)
  return JSON.stringify({ defaultPath: defaultPath, applicationPaths: applicationPaths })
}
`

export async function listMacOpenWithApplications(
  filePath: string
): Promise<OpenWithApplicationCandidate[]> {
  const output = await readOpenWithCommandOutput('osascript', [
    '-l',
    'JavaScript',
    '-e',
    LIST_APPLICATIONS_JXA,
    filePath
  ])
  return parseMacApplicationList(output)
}

export function parseMacApplicationList(output: string): OpenWithApplicationCandidate[] {
  const parsed = JSON.parse(output) as {
    defaultPath?: string | null
    applicationPaths?: unknown[]
  }
  const defaultPath = typeof parsed.defaultPath === 'string' ? parsed.defaultPath : null
  const candidatesByPath = new Map<string, OpenWithApplicationCandidate>()
  const applicationPaths = (parsed.applicationPaths ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (defaultPath && !applicationPaths.includes(defaultPath)) {
    applicationPaths.unshift(defaultPath)
  }
  for (const applicationPath of applicationPaths) {
    if (candidatesByPath.has(applicationPath)) {
      continue
    }
    candidatesByPath.set(applicationPath, {
      id: `macos:${applicationPath}`,
      name: basename(applicationPath).replace(/\.app$/i, ''),
      isDefault: applicationPath === defaultPath,
      launch: { kind: 'macos-application', applicationPath }
    })
  }
  return [...candidatesByPath.values()]
}
