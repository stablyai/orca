export type MobileWebShellPresentationState =
  | 'package-loading'
  | 'package-unavailable'
  | 'hosted-interface'

export function mobileWebShellPresentationState(args: {
  hasSelectedHost: boolean
  hasSession: boolean
  packageLoading: boolean
}): MobileWebShellPresentationState {
  if (!args.hasSelectedHost) {
    return 'package-loading'
  }
  if (args.hasSession) {
    return 'hosted-interface'
  }
  return args.packageLoading ? 'package-loading' : 'package-unavailable'
}

export function mobileWebShellShowsNativeChrome(state: MobileWebShellPresentationState): boolean {
  return state !== 'hosted-interface'
}
