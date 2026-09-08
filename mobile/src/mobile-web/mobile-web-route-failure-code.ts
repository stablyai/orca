export function mobileWebRouteFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/maximum update depth|minified react error #185/i.test(message)) {
    return 'react-update-loop'
  }
  if (/resizeobserver/i.test(message)) {
    return 'resize-observer'
  }
  if (/terminal|xterm|dimensions|parent element/i.test(message)) {
    return 'terminal-render'
  }
  if (error instanceof TypeError) {
    return 'type-error'
  }
  return 'render-error'
}
