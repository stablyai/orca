import type { GitRuntimeOptions } from '../command-runner/git-runtime-options'

export function gitRuntimeOptionsKey(options: GitRuntimeOptions): readonly unknown[] {
  return [options.wslDistro ?? null]
}
