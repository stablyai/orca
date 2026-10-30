import type { GitRuntimeOptions } from '../git-runtime-options'

export function gitRuntimeOptionsKey(options: GitRuntimeOptions): readonly unknown[] {
  return [options.wslDistro ?? null]
}
