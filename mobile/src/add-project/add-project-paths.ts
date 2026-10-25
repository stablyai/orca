import { joinCreateProjectPath } from '../../../src/shared/create-project-location'

export const DEFAULT_PROJECT_PARENT = '~/orca/projects'

// The host requires absolute parents; a phone keyboard makes ~ the natural way to type one.
export function expandHostHomePath(pathValue: string, homeDir: string | null): string {
  const trimmed = pathValue.trim()
  if (!homeDir || !/^~(?:$|[\\/])/.test(trimmed)) {
    return trimmed
  }
  const rest = trimmed.slice(2)
  // Keep a Windows home's separators so stored project paths do not mix / and \.
  const nativeRest = homeDir.includes('\\') ? rest.replace(/\//g, '\\') : rest
  return rest ? joinCreateProjectPath(homeDir, nativeRest) : homeDir
}
