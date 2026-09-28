export const WINDOWS_PROCESS_TREE_REQUIRED = [
  'package.json',
  'lib/index.js',
  'build/Release/windows_process_tree.node'
] as const

export function isRuntimeProcessTreePath(packageRel: string): boolean {
  return (
    packageRel === '' ||
    packageRel.startsWith('lib/') ||
    WINDOWS_PROCESS_TREE_REQUIRED.some(
      (required) => required === packageRel || required.startsWith(`${packageRel}/`)
    )
  )
}
