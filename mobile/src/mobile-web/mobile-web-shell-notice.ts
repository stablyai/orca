// A shell notice is what the user reads; `code` is the stable support identifier shown
// underneath it, so product copy never has to carry an error token.
export type MobileWebShellNotice = {
  message: string
  code?: string
}

const DEFAULT_HOST_NAME = 'your computer'

export function mobileWebShellHostName(name: string | undefined): string {
  return name?.trim() || DEFAULT_HOST_NAME
}
