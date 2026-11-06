import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'

type GitStatusReadArgs = {
  admissionTier?: GitAdmissionTier
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  branchLineTotalMergeBase?: string
}

export function gitStatusReadOptions(args: GitStatusReadArgs, controller: AbortController | null) {
  return {
    includeIgnored: args.includeIgnored ?? false,
    admissionTier: args.admissionTier ?? ('status' as const),
    ...(args.includeLineStats === false ? { includeLineStats: false } : {}),
    ...(args.reuseLineStats === true ? { reuseLineStats: true } : {}),
    ...(args.branchLineTotalMergeBase === undefined
      ? {}
      : { branchLineTotalMergeBase: args.branchLineTotalMergeBase }),
    ...(args.bypassEffectiveUpstreamNegativeCache === true
      ? { bypassEffectiveUpstreamNegativeCache: true }
      : {}),
    ...(controller ? { signal: controller.signal } : {})
  }
}
