import { join, win32 as winPath } from 'node:path'

export function isRuntimeNodePtyPath(sourcePath: string): boolean {
  const normalized = sourcePath.toLowerCase()
  if (normalized.endsWith('.pdb')) {
    return false
  }
  const prebuild = normalized.match(/prebuilds[\\/](win32-[^\\/]+)/)
  return !prebuild || prebuild[1] === `win32-${process.arch}`
}

export function toDaemonHostRelativePath(fromDir: string, absolutePath: string): string {
  return winPath.relative(fromDir, absolutePath).split(winPath.sep).join('/')
}

export function resolveDaemonHostPath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

export function isRuntimeWindowsProcessTreePath(packageDir: string, sourcePath: string): boolean {
  const relative = winPath.relative(packageDir, sourcePath).split(winPath.sep).join('/')
  return (
    relative === '' ||
    relative === 'package.json' ||
    relative === 'lib' ||
    relative.startsWith('lib/') ||
    relative === 'build' ||
    relative === 'build/Release' ||
    relative === 'build/Release/windows_process_tree.node'
  )
}
