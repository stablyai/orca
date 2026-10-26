import {
  joinCreateProjectPath,
  pathSeparatorFor
} from '../../../src/shared/create-project-location'

export const DEFAULT_PROJECT_PARENT = '~/orca/projects'

const HOME_RELATIVE = /^~(?:$|[\\/])/

// Without the host's home a ~ path stays relative, which the host rejects.
export function homeUnknownFor(pathValue: string, homeDir: string | null): boolean {
  return !homeDir && HOME_RELATIVE.test(pathValue.trim())
}

// The host requires absolute parents; a phone keyboard makes ~ the natural way to type one.
export function expandHostHomePath(pathValue: string, homeDir: string | null): string {
  const trimmed = pathValue.trim()
  if (!homeDir || !HOME_RELATIVE.test(trimmed)) {
    return trimmed
  }
  const rest = trimmed.slice(2)
  // Keep a Windows home's separators so stored project paths do not mix / and \.
  const nativeRest = pathSeparatorFor(homeDir) === '\\' ? rest.replace(/\//g, '\\') : rest
  return rest ? joinCreateProjectPath(homeDir, nativeRest) : homeDir
}
